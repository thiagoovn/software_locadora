// server.js
// Autobot WPP - Versão estável e compatível com VM/Windows/Linux
'use strict';

// ===== DEPENDÊNCIAS =====
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const moment = require('moment-timezone');
const puppeteerCore = require('puppeteer-core');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

// ===== CONFIGURAÇÕES =====
const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const PY_API_URL = 'http://localhost:5000/gerar_contrato';
const CLIENTES_FILE = path.join(__dirname, 'clientes.json');
const ADMS_FILE = path.join(__dirname, 'adms.json');

// ===== FUNÇÕES AUXILIARES =====
function normalizarNumero(telefone) {
  if (!telefone) return '';
  let numero = telefone.replace(/\D/g, '');
  if (!numero.startsWith('55')) numero = '55' + numero;
  const match = numero.match(/^55(\d{2})9?(\d{8})$/);
  if (match) numero = `55${match[1]}${match[2]}`;
  return numero;
}

function normalizarTexto(texto) {
  return (texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2), 'utf-8');
      return fallback;
    }
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error('Erro ao ler JSON', file, err.message);
    return fallback;
  }
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Erro ao salvar JSON', file, err.message);
  }
}

// ===== DADOS INICIAIS =====
let clientesDB = loadJSON(CLIENTES_FILE, { clientes: [] });
const ADMINS = loadJSON(ADMS_FILE, { admins: {} }).admins || {};
console.log('👮 Admins carregados:', ADMINS);

// ===== CAMPOS =====
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

// ===== SESSÕES =====
const sessions = new Map();
function startSession(userId, type) {
  sessions.set(userId, { type, step: 0, data: {} });
}
function cancelSession(userId) {
  sessions.delete(userId);
}
function formatChatId(numberOrId) {
  if (!numberOrId) return '';
  const id = String(numberOrId).trim();
  return id.includes('@c.us') ? id : `${id}@c.us`;
}

// ===== PUPPETEER CONFIG =====
const chromePaths = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

const chromeExecutable = chromePaths.find((p) => p && fs.existsSync(p));
if (!chromeExecutable) {
  console.warn('⚠️ Chrome/Chromium não encontrado. Configure a variável CHROME_PATH se necessário.');
}

// ===== CLIENTE WHATSAPP =====
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: chromeExecutable || undefined,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
    ],
  },
});

// ===== VERIFICAÇÃO DE VENCIMENTOS =====
function scheduleDailyCheck() {
  const now = moment.tz('America/Sao_Paulo');
  const target = moment.tz('America/Sao_Paulo').hour(8).minute(30).second(0).millisecond(0);
  if (now.isAfter(target)) target.add(1, 'day');
  const delay = target.diff(now);
  console.log(`🕗 Próxima verificação agendada para: ${target.format('DD/MM/YYYY HH:mm')} (horário de Brasília)`);

  setTimeout(() => {
    checkVencimentos().catch((e) => console.error('Erro em checkVencimentos:', e.message));
    setInterval(() => checkVencimentos().catch((e) => console.error('Erro em checkVencimentos:', e.message)), 24 * 60 * 60 * 1000);
  }, delay);
}

async function checkVencimentos() {
  console.log('🕗 Iniciando verificação de vencimentos automáticos...');
  const hoje = new Date();
  const vencendoHoje = [];
  const proximos = [];

  clientesDB.clientes.forEach((c) => {
    if (!c.data_vencimento) return;
    const [d, m, a] = c.data_vencimento.split('/').map(Number);
    const data = new Date(a, m - 1, d);
    if (data.toDateString() === hoje.toDateString()) vencendoHoje.push(c);
    else if (data > hoje) proximos.push(c);
  });

  for (const cliente of vencendoHoje) {
    try {
      const numero = normalizarNumero(cliente.telefone);
      if (!numero || numero.length < 12) continue;
      const chatId = `${numero}@c.us`;
      const msg = `Olá ${cliente.nome}, tudo bem? O veículo ${cliente.carro} vence hoje. Por favor, entre em contato para regularizar. Obrigado!`;
      await client.sendMessage(chatId, msg);
    } catch (err) {
      console.error(`❌ Erro ao enviar cobrança para ${cliente.nome}:`, err.message);
    }
  }

  const admMsg = [];
  if (vencendoHoje.length)
    admMsg.push('💰 Clientes com vencimento HOJE:', ...vencendoHoje.map((c) => `- ${c.nome} (${c.carro} - ${c.placa})`));
  if (proximos.length)
    admMsg.push('\n📅 Próximos vencimentos:', ...proximos.map((c) => `${c.data_vencimento} - ${c.nome} (${c.carro})`));
  const finalMsg = admMsg.length ? admMsg.join('\n') : '✅ Nenhum vencimento hoje.';

  for (const adm in ADMINS) {
    try {
      const numero = adm.startsWith('55') ? adm : `55${adm}`;
      await client.sendMessage(`${numero}@c.us`, finalMsg);
    } catch (err) {
      console.error(`Erro ao enviar para admin ${ADMINS[adm]}:`, err.message);
    }
  }

  console.log('✅ Verificação concluída.');
}

// ===== EVENTOS =====
client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
  console.log('📱 Escaneie o QR code para conectar ao WhatsApp.');
});

client.on('ready', () => {
  console.log('✅ WhatsApp pronto e conectado!');
  scheduleDailyCheck();
});

client.on('auth_failure', (msg) => console.error('❌ Falha na autenticação:', msg));
client.on('disconnected', (reason) => {
  console.warn('⚠️ Desconectado:', reason);
  setTimeout(() => {
    console.log('🔄 Tentando reconectar...');
    client.initialize().catch((e) => console.error('Erro ao reconectar:', e.message));
  }, 10000);
});

// ===== HANDLER DE MENSAGENS =====
client.on('message', async (msg) => {
  try {
    const from = msg.from;
    const comando = normalizarTexto(msg.body || '');
    console.log('📩 Mensagem recebida de', from, '→', comando);

    const fromClean = from.replace('@c.us', '').replace('@s.whatsapp.net', '');
    const adminKeys = Object.keys(ADMINS);
    const isAdm = adminKeys.includes(from) || adminKeys.includes(fromClean);

    if (comando === '/ajuda') {
      await msg.reply(
        `📘 Comandos disponíveis:\n- /contrato → iniciar criação de contrato\n- /cobranca → cadastrar cliente\n- /status → listar vencimentos\n- /cancelar → cancelar operação atual`
      );
      return;
    }

    if (!isAdm) {
      await msg.reply('🚫 Você não tem permissão para usar este comando.');
      return;
    }

    if (comando === '/contrato') {
      startSession(from, 'contrato');
      await msg.reply(`📄 Iniciando criação de contrato...\n${FIELDS_CONTRATO[0].prompt}`);
      return;
    }

    if (comando === '/cobranca') {
      startSession(from, 'cobranca');
      await msg.reply(`🧾 Iniciando cadastro de cliente...\n${FIELDS_COBRANCA[0].prompt}`);
      return;
    }

    if (comando === '/status') {
      if (!clientesDB.clientes.length) {
        await msg.reply('📂 Nenhum cliente cadastrado.');
        return;
      }

      const hoje = new Date();
      const vencendoHoje = [];
      const proximos = [];

      clientesDB.clientes.forEach((c) => {
        if (!c.data_vencimento) return;
        const [d, m, a] = c.data_vencimento.split('/').map(Number);
        const data = new Date(a, m - 1, d);
        if (data.toDateString() === hoje.toDateString()) vencendoHoje.push(c);
        else if (data > hoje) proximos.push(c);
      });

      let texto = '📅 Status de Vencimentos:\n\n';
      texto += vencendoHoje.length
        ? '💰 Vencendo Hoje:\n' + vencendoHoje.map((c) => `- ${c.nome} (${c.carro} - ${c.placa})`).join('\n')
        : '✅ Nenhum vencimento hoje.\n';
      texto += '\n\n📆 Próximos Vencimentos:\n';
      texto += proximos.length
        ? proximos.map((c) => `${c.data_vencimento} - ${c.nome}`).join('\n')
        : '✅ Nenhum futuro.';
      await msg.reply(texto);
      return;
    }

    if (sessions.has(from)) {
      const session = sessions.get(from);

      if (session.type === 'contrato') {
        const field = FIELDS_CONTRATO[session.step];
        session.data[field.key] = msg.body.trim();
        session.step++;

        if (session.step < FIELDS_CONTRATO.length) {
          await msg.reply(FIELDS_CONTRATO[session.step].prompt);
        } else {
          await msg.reply('📄 Gerando contrato, aguarde...');
          try {
            const resp = await axios.post(PY_API_URL, session.data, {
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

      if (session.type === 'cobranca') {
        const field = FIELDS_COBRANCA[session.step];
        session.data[field.key] = msg.body.trim();
        session.step++;

        if (session.step < FIELDS_COBRANCA.length) {
          await msg.reply(FIELDS_COBRANCA[session.step].prompt);
        } else {
          clientesDB.clientes.push(session.data);
          saveJSON(CLIENTES_FILE, clientesDB);
          await msg.reply(`✅ Cliente ${session.data.nome} cadastrado com sucesso.`);
          sessions.delete(from);
        }
        return;
      }
    }

    await msg.reply('Envie /ajuda para ver os comandos disponíveis.');
  } catch (err) {
    console.error('Erro no handler de mensagens:', err.message);
  }
});

// ===== EXPRESS ROUTES =====
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

// ===== INICIALIZAÇÃO =====
(async () => {
  try {
    await client.initialize();
  } catch (err) {
    console.error('❌ Erro ao inicializar cliente WhatsApp:', err.message);
  }

  app.listen(PORT, () => console.log(`🚀 Servidor Node rodando na porta ${PORT}`));
})();
