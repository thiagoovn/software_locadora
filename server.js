const puppeteer = require('puppeteer');
process.env.PUPPETEER_EXECUTABLE_PATH = puppeteer.executablePath();


// === app.js ===
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const moment = require('moment-timezone');

const app = express();
app.use(bodyParser.json());

// ===== CONFIGURAÇÕES =====
const PY_API_URL = 'http://localhost:5000/gerar_contrato';
const CLIENTES_FILE = path.join(__dirname, 'clientes.json');
const ADMS_FILE = path.join(__dirname, 'adms.json');

// === FUNÇÃO DE NORMALIZAÇÃO DE NÚMERO ===
function normalizarNumero(telefone) {
  if (!telefone) return '';
  let numero = telefone.replace(/\D/g, '');
  if (!numero.startsWith('55')) numero = '55' + numero;
  const match = numero.match(/^55(\d{2})9(\d{8})$/);
  if (match) numero = `55${match[1]}${match[2]}`;
  return numero;
}

// === FUNÇÃO DE NORMALIZAÇÃO DE TEXTO ===
function normalizarTexto(texto) {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

// === FUNÇÕES DE ARQUIVOS ===
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

// === DADOS INICIAIS ===
let clientesDB = loadJSON(CLIENTES_FILE, { clientes: [] });
const ADMINS = loadJSON(ADMS_FILE, { admins: {} }).admins;
console.log('👮 Admins carregados:', ADMINS);

// === CONFIG WHATSAPP ===
const client = new Client({ authStrategy: new LocalAuth() });

client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
  console.log('📱 Escaneie este QR code para conectar ao WhatsApp.');
});

client.on('ready', () => {
  console.log('✅ WhatsApp pronto e conectado!');
  scheduleDailyCheck();
});

const sessions = new Map();

// === CAMPOS DOS FLUXOS ===
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

// === FUNÇÕES DE SESSÃO ===
function startSession(userId, type) {
  sessions.set(userId, { type, step: 0, data: {} });
}
function cancelSession(userId) {
  sessions.delete(userId);
}
function formatChatId(numberOrId) {
  return numberOrId.includes('@c.us') ? numberOrId : `${numberOrId}@c.us`;
}

// === ROTINA AUTOMÁTICA DE COBRANÇAS ===
function scheduleDailyCheck() {
  // Usa o fuso horário de São Paulo (UTC−3)
  const now = moment.tz('America/Sao_Paulo');
  const target = moment.tz('America/Sao_Paulo')
    .hour(8)
    .minute(30)
    .second(0)
    .millisecond(0);

  // Se já passou das 08:30 de hoje, agenda para amanhã
  if (now.isAfter(target)) {
    target.add(1, 'day');
  }

  const delay = target.diff(now);

  console.log(
    `🕗 Próxima verificação agendada para: ${target.format('DD/MM/YYYY HH:mm')} (horário de Brasília)`
  );

  // Executa no horário calculado e repete a cada 24h
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

  // Envia cobranças
  for (const cliente of vencendoHoje) {
    try {
      let numero = normalizarNumero(cliente.telefone);
      if (numero.length < 12) continue;
      const chatId = numero + '@c.us';
      const msg = `Olá ${cliente.nome}, tudo bem? O veículo ${cliente.carro} está vencendo hoje. Por favor, entre em contato com o número 81995331107 para regularizar. Obrigado!`;
      await client.sendMessage(chatId, msg);
    } catch (err) {
      console.error(`❌ Erro ao enviar cobrança para ${cliente.nome}:`, err.message);
    }
  }

  // Mensagem para admins
  const admMsg = [];
  if (vencendoHoje.length)
    admMsg.push('💰 *Clientes com vencimento HOJE:*', ...vencendoHoje.map((c) => `- ${c.nome} (${c.carro} - ${c.placa})`));
  if (proximos.length)
    admMsg.push('\n📅 *Próximos vencimentos:*', ...proximos.map((c) => `${c.data_vencimento} - ${c.nome} (${c.carro})`));
  const finalMsg = admMsg.length ? admMsg.join('\n') : '✅ Nenhum vencimento hoje.';

  for (const adm in ADMINS) {
    try {
      const numero = adm.startsWith('55') ? adm : '55' + adm;
      const chatId = numero + '@c.us';
      await client.sendMessage(chatId, finalMsg);
    } catch (err) {
      console.error(`Erro ao enviar para admin ${ADMINS[adm]}:`, err.message);
    }
  }

  console.log('✅ Verificação concluída.');
}

// === HANDLER PRINCIPAL ===
client.on('message', async (msg) => {
  const from = msg.from;
  const comando = normalizarTexto(msg.body || '');

  console.log('📩 DEBUG: Mensagem recebida de', from, '→', comando);

  const fromClean = from.replace('@c.us', '').replace('@s.whatsapp.net', '');
  const adminKeys = Object.keys(ADMINS);
  const isAdm = adminKeys.includes(from) || adminKeys.includes(fromClean);

  // === COMANDO AJUDA ===
  if (comando === '/ajuda') {
    const helpMsg = `
📘 *Comandos disponíveis:*
- /contrato → iniciar criação de contrato
- /cobrança ou /cobranca → cadastrar cliente
- /status → listar vencimentos
- /remover → remover cliente
- /cancelar → cancelar operação atual
- /ajuda → ver esta lista
`;
    await msg.reply(helpMsg);
    return;
  }

  // === BLOQUEIO NÃO ADM ===
  if (!isAdm) {
    await msg.reply(`🚫 Você não tem permissão para usar este comando.`);
    return;
  }

  // === CONTRATO ===
  if (comando === '/contrato') {
    startSession(from, 'contrato');
    await msg.reply(`📄 Iniciando criação de contrato...\n${FIELDS_CONTRATO[0].prompt}`);
    return;
  }

  // === COBRANÇA ===
  if (comando === '/cobranca' || comando === '/cobrança') {
    startSession(from, 'cobranca');
    await msg.reply(`🧾 Iniciando cadastro de cliente...\n${FIELDS_COBRANCA[0].prompt}`);
    return;
  }

  // === STATUS ===
  if (comando === '/status') {
    if (clientesDB.clientes.length === 0) {
      await msg.reply('📂 Nenhum cliente cadastrado.');
      return;
    }

    const hoje = new Date();
    const vencendoHoje = [];
    const proximos = [];

    clientesDB.clientes.forEach((c) => {
      const [d, m, a] = c.data_vencimento.split('/').map(Number);
      const data = new Date(a, m - 1, d);
      if (data.toDateString() === hoje.toDateString()) vencendoHoje.push(c);
      else if (data > hoje) proximos.push(c);
    });

    let texto = '📅 *Status de Vencimentos:*\n\n';
    texto += vencendoHoje.length
      ? '💰 *Vencendo Hoje:*\n' + vencendoHoje.map((c) => `- ${c.nome} (${c.carro} - ${c.placa})`).join('\n')
      : '✅ Nenhum vencimento hoje.\n';
    texto += '\n\n📆 *Próximos Vencimentos:*\n';
    texto += proximos.length ? proximos.map((c) => `${c.data_vencimento} - ${c.nome}`).join('\n') : '✅ Nenhum futuro.';

    await msg.reply(texto);
    return;
  }

  // === FLUXOS DE SESSÃO ===
  if (sessions.has(from)) {
    const session = sessions.get(from);

    // === Contrato ===
    if (session.type === 'contrato') {
      const field = FIELDS_CONTRATO[session.step];
      session.data[field.key] = msg.body.trim();
      session.step++;

      if (session.step < FIELDS_CONTRATO.length) {
        await msg.reply(FIELDS_CONTRATO[session.step].prompt);
      } else {
        await msg.reply('📄 Gerando contrato, aguarde...');
        try {
          const resp = await axios.post(PY_API_URL, JSON.stringify(session.data), {
                responseType: 'arraybuffer',
                 timeout: 120000,
                 headers: { 'Content-Type': 'application/json' },

          });
          const tmpDir = os.tmpdir();
          const filename = `contrato_${Date.now()}.pdf`;
          const tmpPath = path.join(tmpDir, filename);
          fs.writeFileSync(tmpPath, Buffer.from(resp.data));
          const media = MessageMedia.fromFilePath(tmpPath);
          await client.sendMessage(from, media, { caption: '✅ Aqui está o seu contrato.' });
          fs.unlinkSync(tmpPath);
        } catch (err) {
          console.error('Erro ao gerar contrato:', err.message);
          await msg.reply('❌ Erro ao gerar contrato. Tente novamente.');
        }
        sessions.delete(from);
      }
      return;
    }

    // === Cobrança ===
    if (session.type === 'cobranca') {
      const field = FIELDS_COBRANCA[session.step];
      session.data[field.key] = msg.body.trim();
      session.step++;

      if (session.step < FIELDS_COBRANCA.length) {
        await msg.reply(FIELDS_COBRANCA[session.step].prompt);
      } else {
        clientesDB.clientes.push(session.data);
        saveJSON(CLIENTES_FILE, clientesDB);
        await msg.reply(`✅ Cliente *${session.data.nome}* cadastrado com sucesso.`);
        sessions.delete(from);
      }
      return;
    }
  }

  await msg.reply('Envie /ajuda para ver os comandos disponíveis.');
});

// === EXPRESS API ===
app.post('/send', async (req, res) => {
  try {
    await client.sendMessage(formatChatId(req.body.number), req.body.message);
    res.send({ status: '✅ Mensagem enviada' });
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

// === TESTE MANUAL DE COBRANÇAS ===
app.get('/testar-cobranca', async (req, res) => {
  try {
    await checkVencimentos();
    res.send('✅ Teste de cobrança executado.');
  } catch (err) {
    res.status(500).send('Erro ao testar cobrança: ' + err.message);
  }
});

client.initialize();
app.listen(3000, () => console.log('🚀 Servidor Node rodando na porta 3000'));

