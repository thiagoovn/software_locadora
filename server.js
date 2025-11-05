// === DEPENDÊNCIAS BÁSICAS ===
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const moment = require('moment-timezone');

// === CONFIGURAÇÃO EXPRESS ===
const app = express();
app.use(bodyParser.json());

// === ENDPOINT DO PYTHON (FLASK) ===
const PY_API_URL = 'http://localhost:5000/gerar_contrato';

// === ARQUIVOS DE DADOS ===
const CLIENTES_FILE = path.join(__dirname, 'clientes.json');
const ADMS_FILE = path.join(__dirname, 'adms.json');

// === FUNÇÕES DE SUPORTE ===
function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function normalizarNumero(telefone) {
  if (!telefone) return '';
  let numero = telefone.replace(/\D/g, '');
  if (!numero.startsWith('55')) numero = '55' + numero;
  const match = numero.match(/^55(\d{2})9?(\d{8})$/);
  if (match) numero = `55${match[1]}${match[2]}`;
  return numero;
}

function normalizarTexto(texto) {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

// === BANCO DE DADOS LOCAL ===
let clientesDB = loadJSON(CLIENTES_FILE, { clientes: [] });
const ADMINS = loadJSON(ADMS_FILE, { admins: {} }).admins || {};
console.log('👮 Admins carregados:', ADMINS);

// === CONFIGURAÇÃO DO WHATSAPP ===
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "autobot-wpp"
  }),
  puppeteer: {
    headless: false,
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--disable-extensions',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--no-zygote',
      '--no-first-run',
      '--window-size=1280,900',
      '--disable-software-rasterizer',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--use-angle=swiftshader'
    ]
  }
});

// === LOGS DE DIAGNÓSTICO ===
client.on('qr', () => {
  console.log('📱 QR gerado, aguardando escaneamento...');
});
client.on('authenticated', () => {
  console.log('🔐 Autenticado com sucesso!');
});
client.on('auth_failure', (message) => {
  console.log('❌ Falha de autenticação:', message);
});
client.on('ready', () => {
  console.log('✅ WhatsApp pronto e conectado!');
  scheduleDailyCheck();
});
client.on('disconnected', (reason) => {
  console.log('⚠️ Desconectado:', reason);
});

// === FLUXOS ===
const sessions = new Map();

const FIELDS_CONTRATO = [
  { key: 'nome', prompt: 'Digite o NOME do locatário:' },
  { key: 'cpf', prompt: 'Digite o CPF/CNPJ:' },
  { key: 'telefone', prompt: 'Digite o TELEFONE (ex: (81) 9xxxx-xxxx):' },
  { key: 'email', prompt: 'Digite o E-MAIL (ou "-" se não tiver):' },
  { key: 'endereco', prompt: 'Digite o ENDEREÇO completo:' },
  { key: 'carro', prompt: 'Digite o MODELO do veículo:' },
  { key: 'placa', prompt: 'Digite a PLACA do veículo:' },
  { key: 'renavam', prompt: 'Digite o RENAVAM (ou "-" se não tiver):' },
  { key: 'data_inicio', prompt: 'Digite a DATA/HORA de início (DD/MM/YYYY HH:MM):' },
  { key: 'data_devolucao', prompt: 'Digite a DATA/HORA de devolução prevista (DD/MM/YYYY HH:MM):' },
  { key: 'valor_diaria', prompt: 'Digite o VALOR DA DIÁRIA (ex: 150,00):' },
  { key: 'desconto', prompt: 'Digite o VALOR DO DESCONTO (ex: 0,00):' },
  { key: 'forma_pag', prompt: 'Digite a FORMA DE PAGAMENTO (PIX, DINHEIRO, CARTÃO):' },
  { key: 'observacoes', prompt: 'Digite OBSERVAÇÕES (ou "-" se não houver):' },
];

const FIELDS_COBRANCA = [
  { key: 'nome', prompt: 'Digite o NOME do cliente:' },
  { key: 'placa', prompt: 'Digite a PLACA do veículo:' },
  { key: 'carro', prompt: 'Digite o MODELO do veículo:' },
  { key: 'data_vencimento', prompt: 'Digite a DATA DE VENCIMENTO (DD/MM/YYYY):' },
  { key: 'telefone', prompt: 'Digite o TELEFONE do cliente (com DDD):' },
];

function startSession(userId, type) {
  sessions.set(userId, { type, step: 0, data: {} });
}
function cancelSession(userId) {
  sessions.delete(userId);
}
function formatChatId(numberOrId) {
  return numberOrId.includes('@c.us') ? numberOrId : `${numberOrId}@c.us`;
}

// === VERIFICAÇÕES AGENDADAS ===
function scheduleDailyCheck() {
  const now = moment.tz('America/Sao_Paulo');
  const target = moment.tz('America/Sao_Paulo')
    .hour(8)
    .minute(30)
    .second(0)
    .millisecond(0);
  if (now.isAfter(target)) target.add(1, 'day');
  const delay = target.diff(now);
  console.log(`🕗 Próxima verificação agendada para: ${target.format('DD/MM/YYYY HH:mm')} (horário de Brasília)`);
  setTimeout(() => {
    checkVencimentos();
    setInterval(checkVencimentos, 24 * 60 * 60 * 1000);
  }, delay);
}

async function checkVencimentos() {
  console.log('🕗 Iniciando verificação de vencimentos automáticos...');
  const hoje = new Date();
  const vencendoHoje = [];
  const proximos = [];

  clientesDB.clientes.forEach((c) => {
    const [d, m, a] = c.data_vencimento.split('/').map(Number);
    const data = new Date(a, m - 1, d);
    if (data.toDateString() === hoje.toDateString()) vencendoHoje.push(c);
    else if (data > hoje) proximos.push(c);
  });

  for (const cliente of vencendoHoje) {
    try {
      let numero = normalizarNumero(cliente.telefone);
      if (numero.length < 12) continue;
      const chatId = numero + '@c.us';
      const msg = `Olá ${cliente.nome}, tudo bem? O veículo ${cliente.carro} está vencendo hoje. Por favor, entre em contato para regularizar.`;
      await client.sendMessage(chatId, msg);
    } catch (err) {
      console.error(`❌ Erro ao enviar cobrança para ${cliente.nome}:`, err.message);
    }
  }
  console.log('✅ Verificação concluída.');
}

// === HANDLER DE MENSAGENS ===
client.on('message', async (msg) => {
  const from = msg.from;
  const comando = normalizarTexto(msg.body || '');
  console.log('📩 Mensagem recebida de', from, '→', comando);

  const fromClean = from.replace('@c.us', '').replace('@s.whatsapp.net', '');
  const adminKeys = Object.keys(ADMINS);
  const isAdm = adminKeys.includes(from) || adminKeys.includes(fromClean);

  if (!isAdm) {
    await msg.reply('🚫 Você não tem permissão para usar este comando.');
    return;
  }

  if (comando === '/ajuda') {
    const helpMsg = `
📘 *Comandos disponíveis:*
- /contrato → iniciar criação de contrato
- /cobrança → cadastrar cliente
- /status → listar vencimentos
- /cancelar → cancelar operação atual`;
    await msg.reply(helpMsg);
    return;
  }

  if (comando === '/contrato') {
    startSession(from, 'contrato');
    await msg.reply(`📄 Iniciando criação de contrato...\n${FIELDS_CONTRATO[0].prompt}`);
    return;
  }

  if (comando === '/cobranca' || comando === '/cobrança') {
    startSession(from, 'cobranca');
    await msg.reply(`🧾 Iniciando cadastro de cliente...\n${FIELDS_COBRANCA[0].prompt}`);
    return;
  }

  if (sessions.has(from)) {
    const session = sessions.get(from);
    const field = session.type === 'contrato'
      ? FIELDS_CONTRATO[session.step]
      : FIELDS_COBRANCA[session.step];

    session.data[field.key] = msg.body.trim();
    session.step++;

    const fieldsList = session.type === 'contrato' ? FIELDS_CONTRATO : FIELDS_COBRANCA;

    if (session.step < fieldsList.length) {
      await msg.reply(fieldsList[session.step].prompt);
    } else {
      if (session.type === 'contrato') {
        await msg.reply('📄 Gerando contrato, aguarde...');
        try {
          const resp = await axios.post(PY_API_URL, JSON.stringify(session.data), {
            responseType: 'arraybuffer',
            timeout: 120000,
            headers: { 'Content-Type': 'application/json' },
          });
          const tmpPath = path.join(os.tmpdir(), `contrato_${Date.now()}.pdf`);
          fs.writeFileSync(tmpPath, Buffer.from(resp.data));
          const media = MessageMedia.fromFilePath(tmpPath);
          await client.sendMessage(from, media, { caption: '✅ Aqui está o seu contrato.' });
          fs.unlinkSync(tmpPath);
        } catch (err) {
          console.error('Erro ao gerar contrato:', err.message);
          await msg.reply('❌ Erro ao gerar contrato. Tente novamente.');
        }
      } else {
        clientesDB.clientes.push(session.data);
        saveJSON(CLIENTES_FILE, clientesDB);
        await msg.reply(`✅ Cliente *${session.data.nome}* cadastrado com sucesso.`);
      }
      sessions.delete(from);
    }
  }
});

// === API EXPRESS ===
app.post('/send', async (req, res) => {
  try {
    await client.sendMessage(formatChatId(req.body.number), req.body.message);
    res.send({ status: '✅ Mensagem enviada' });
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

app.get('/testar-cobranca', async (req, res) => {
  try {
    await checkVencimentos();
    res.send('✅ Teste de cobrança executado.');
  } catch (err) {
    res.status(500).send('Erro ao testar cobrança: ' + err.message);
  }
});

// === INICIALIZAÇÃO ===
console.log('🟡 Iniciando Autobot WPP... Aguarde o QR Code.');
client.initialize();
app.listen(3000, () => console.log('🚀 Servidor Node rodando na porta 3000'));
