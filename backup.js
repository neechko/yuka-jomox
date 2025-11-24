import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import axios from "axios";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import dotenv from "dotenv";
import "dotenv/config";
import { handleLyricsCommand } from "./lyrics.js";

dotenv.config();

// ==================== ENV ====================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const NOTIFY_CHANNEL_ID = process.env.CHANNEL_ID;
const HISTORY_COUNT = parseInt(process.env.HISTORY_COUNT) || 5;
const TRIM_CHARS = parseInt(process.env.TRIM_CHARS) || 700;
const MAX_OUTPUT_CHARS = parseInt(process.env.MAX_OUTPUT_CHARS) || 1800;
const PREFIX = process.env.PREFIX || "?"; // bisa ubah via env

// ==================== API CONFIG ====================
const API_CONFIG = {
  "yuka1": { name: "OpenRouter1", key: process.env.OPENROUTER_API_KEY_1 },
  "yuka2": { name: "OpenRouter2", key: process.env.OPENROUTER_API_KEY_2 },
};

// ==================== FREE MODELS ====================
let MODEL_PRIORITY = [
  "deepseek/deepseek-r1:free",
  "deepseek/deepseek-chat-v3-0324:free",
  "meta-llama/llama-4-maverick:free",
  "meta-llama/llama-4-scout:free",
  "qwen/qwen3-235b-a22b:free",
  "openai/gpt-oss-20b:free"
];
let LAST_PRIORITY = [...MODEL_PRIORITY];

// ==================== CLIENT ====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

let db;

// ==================== INIT DB ====================
async function initDB() {
  db = await open({ filename: "./yuka_history.db", driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      prompt TEXT,
      response TEXT,
      created_at TEXT
    )
  `);

  const columns = await db.all("PRAGMA table_info(history)");
  const columnNames = columns.map(c => c.name);
  if (!columnNames.includes("model")) {
    await db.exec("ALTER TABLE history ADD COLUMN model TEXT");
    console.log("🟢 Kolom 'model' ditambahkan ke tabel history");
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS model_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT,
      success INTEGER,
      used_at TEXT
    )
  `);
}

// ==================== HISTORY ====================
async function getRelevantHistory(userId, replyMsgId) {
  let extraHistory = [];
  if (replyMsgId) {
    try {
      const repliedMsg = await client.channels.cache
        .get(NOTIFY_CHANNEL_ID)
        ?.messages.fetch(replyMsgId);

      if (repliedMsg && repliedMsg.author.id === client.user.id) {
        const row = await db.get(
          "SELECT prompt, response, model FROM history WHERE response = ? LIMIT 1",
          repliedMsg.content
        );
        if (row) extraHistory.push({ prompt: row.prompt, response: row.response, model: row.model });
      }
    } catch {}
  }

  const historyRows = await db.all(
    "SELECT prompt, response, model FROM history WHERE user_id = ? ORDER BY id DESC LIMIT ?",
    userId, HISTORY_COUNT
  );

  return [...historyRows.reverse(), ...extraHistory];
}

async function clearHistory(userId) {
  await db.run("DELETE FROM history WHERE user_id = ?", userId);
}

// ==================== ADAPTIVE MODEL ====================
async function getAdaptiveModels() {
  const stats = await db.all(`
    SELECT model, SUM(success) as ok, COUNT(*) as total 
    FROM model_usage 
    GROUP BY model
  `);
  
  return [...MODEL_PRIORITY].sort((a, b) => {
    const statA = stats.find(s => s.model === a);
    const statB = stats.find(s => s.model === b);
    const rateA = statA ? statA.ok / statA.total : 1;
    const rateB = statB ? statB.ok / statB.total : 1;
    return rateB - rateA;
  });
}

async function refreshModelPriority() {
  const newOrder = await getAdaptiveModels();
  if (JSON.stringify(newOrder) !== JSON.stringify(LAST_PRIORITY)) {
    LAST_PRIORITY = newOrder;
    console.log("🔄 Prioritas model diperbarui:", newOrder);

    try {
      const channel = await client.channels.fetch(NOTIFY_CHANNEL_ID);
      if (channel) {
        const prettyList = newOrder.map((m, i) => `${i+1}️⃣ ${m}`).join("\n");
        channel.send(`🔄 **Prioritas model diperbarui:**\n${prettyList}`);
      }
    } catch (err) {
      console.error("❌ Gagal kirim notifikasi perubahan prioritas:", err.message);
    }
  }
}

// ==================== AI CALL ====================
async function callAI(messages, apiKey, models = LAST_PRIORITY) {
  for (const model of models) {
    let delay = 2000;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const response = await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",
          { model, messages },
          { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 30000 }
        );

        const result = response.data.choices?.[0]?.message?.content || "⚠️ Tidak ada jawaban.";
        await db.run("INSERT INTO model_usage (model, success, used_at) VALUES (?, 1, ?)", model, new Date().toISOString());
        return { result, model };
      } catch (err) {
        if (err.response?.status === 429) {
          console.log(`⏳ ${model} limit. Retry ${attempt}/4 dalam ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
          delay *= 2;
        } else {
          console.error(`❌ Error model ${model}:`, err.response?.data || err.message);
          await db.run("INSERT INTO model_usage (model, success, used_at) VALUES (?, 0, ?)", model, new Date().toISOString());
          break;
        }
      }
    }
  }
  return null;
}

// ==================== SEND REQUEST ====================
async function sendRequest(prompt, msg, apiData, customModels) {
  const extraHistory = await getRelevantHistory(msg.author.id, msg.reference?.messageId);
  const messages = [
    { role: "system", content: "Kamu adalah Yuka, AI sopan, informatif, selalu menyebut dirimu Yuka." },
    ...extraHistory.flatMap(h => [
      { role: "user", content: h.prompt.slice(-TRIM_CHARS) },
      { role: "assistant", content: h.response.slice(-TRIM_CHARS) }
    ]),
    { role: "user", content: prompt }
  ];

  const thinkingMsg = await msg.reply("⏳ Yuka sedang berpikir...");

  const modelsToUse = customModels || LAST_PRIORITY;
  const aiResponse = await callAI(messages, apiData.key, modelsToUse);

  if (!aiResponse) {
    return thinkingMsg.edit("❌ Semua model gratis sedang penuh. Coba lagi nanti.");
  }

  const { result, model } = aiResponse;
  const finalText = `✅ **Model dipakai:** ${model}\n\n${result}`;

  const chunks = [];
  for (let i = 0; i < finalText.length; i += MAX_OUTPUT_CHARS) {
    chunks.push(finalText.slice(i, i + MAX_OUTPUT_CHARS));
  }

  await thinkingMsg.edit(chunks[0]);
  for (let j = 1; j < chunks.length; j++) {
    await msg.channel.send(chunks[j]);
  }

  if (result.length <= 10000) {
    await db.run(
      "INSERT INTO history (user_id, prompt, response, created_at, model) VALUES (?, ?, ?, ?, ?)",
      msg.author.id, prompt, result, new Date().toISOString(), model
    );
  }
}

// ==================== EVENT HANDLER ====================
client.once("ready", async () => {
  console.log(`✅ Yuka siap! Logged in sebagai ${client.user.tag}`);
  if (!NOTIFY_CHANNEL_ID) return console.warn("⚠️ CHANNEL_ID belum di-set di .env");

  try {
    const channel = await client.channels.fetch(NOTIFY_CHANNEL_ID);
    if (channel) channel.send("✅ Halo guys! Yuka siap membantu 🚀");
  } catch (err) {
    console.error("❌ Gagal kirim notifikasi:", err.message);
  }

  setInterval(refreshModelPriority, 10 * 60 * 1000);
});

client.on("messageCreate", async msg => {
  if (msg.author.bot) return;
  const content = msg.content.trim();

  // ========== Commands ==========

  // ?yuka1 / ?yuka2 => API spesifik, model acak
  const cmdMatch = content.match(new RegExp(`^\\${PREFIX}(yuka\\d+)\\s*(.*)`));
  if (cmdMatch) {
    const cmd = cmdMatch[1];
    const prompt = cmdMatch[2];
    if (!prompt) return msg.reply("❌ Tulis pertanyaan setelah command.");

    const apiData = API_CONFIG[cmd];
    if (!apiData) return msg.reply("❌ API tidak tersedia untuk command ini.");

    // acak model untuk masing-masing API
    const randomModel = [...MODEL_PRIORITY].sort(() => Math.random() - 0.5);
    return sendRequest(prompt, msg, apiData, randomModel);
  }

  // ?yuka => semua model gratis acak, bebas API
  if (content.startsWith(`${PREFIX}yuka`)) {
    const prompt = content.slice(PREFIX.length + 4).trim();
    if (!prompt) return msg.reply("❌ Tulis pertanyaan setelah ?yuka.");
    // pilih API random dari yg tersedia
    const apiKeys = Object.values(API_CONFIG);
    const randomApi = apiKeys[Math.floor(Math.random() * apiKeys.length)];
    const randomModels = [...MODEL_PRIORITY].sort(() => Math.random() - 0.5);
    return sendRequest(prompt, msg, randomApi, randomModels);
  }

  // HISTORY
  if (content === `${PREFIX}history`) {
    const rows = await db.all(
      "SELECT prompt, response, created_at FROM history WHERE user_id = ? ORDER BY id DESC LIMIT 5",
      msg.author.id
    );
    if (!rows.length) return msg.reply("Tidak ada history.");

    const historyEmbed = new EmbedBuilder()
      .setTitle("🕒 History Chatmu (terakhir 5)")
      .setColor(0xffaa00)
      .setFooter({ text: "Yuka AI Bot" })
      .setTimestamp();

    let desc = "";
    for (const r of rows) {
      desc += `**Q:** ${r.prompt}\n**A:** ${r.response}\n*${r.created_at}*\n\n`;
    }
    historyEmbed.setDescription(desc.slice(0, 4096));
    return msg.reply({ embeds: [historyEmbed] });
  }

  // CLEAR HISTORY
  if (content === `${PREFIX}clearhistory`) {
    await clearHistory(msg.author.id);
    return msg.reply("🗑️ Semua history chatmu berhasil dihapus!");
  }

  // STATS
  if (content === `${PREFIX}stats`) {
    const rows = await db.all(`
      SELECT model,
             SUM(success) as sukses,
             COUNT(*) as total,
             ROUND((SUM(success) * 100.0) / COUNT(*), 2) as rate
      FROM model_usage
      GROUP BY model
      ORDER BY rate DESC
    `);

    if (!rows.length) return msg.reply("📊 Belum ada data penggunaan model.");

    function makeBar(rate) {
      const filled = Math.round(rate / 5); // 20 segmen
      return "█".repeat(filled) + "░".repeat(20 - filled);
    }

    let desc = rows.map(r => 
      `✅ **${r.model}**\n[${makeBar(r.rate)}] ${r.rate}% (${r.sukses}/${r.total})`
    ).join("\n\n");

    const statsEmbed = new EmbedBuilder()
      .setTitle("📊 Statistik Model (Visual)")
      .setColor(0x33cc33)
      .setDescription(desc)
      .setFooter({ text: "Yuka AI - Adaptive Mode" })
      .setTimestamp();

    return msg.reply({ embeds: [statsEmbed] });
  }

  // HELP
  if (content === `${PREFIX}help`) {
    const helpEmbed = new EmbedBuilder()
      .setTitle("📖 Yuka Commands")
      .setColor(0x00ffff)
      .setDescription(
        `**?yuka1 / ?yuka2 [pertanyaan]** - Tanya Yuka sesuai API\n` +
        `**?yuka [pertanyaan]** - Tanya Yuka semua model acak\n` +
        `**${PREFIX}history** - Lihat chat terakhir\n` +
        `**${PREFIX}clearhistory** - Hapus semua history chatmu\n` +
        `**${PREFIX}stats** - Lihat statistik model 24 jam terakhir\n` +
        `**${PREFIX}ping** - Cek latency bot\n` +
        `**${PREFIX}help** - Tampilkan command ini`
      )
      .setFooter({ text: "Yuka AI Bot" })
      .setTimestamp();
    return msg.reply({ embeds: [helpEmbed] });
  }

  // PING
  if (content === `${PREFIX}ping`) {
    const latency = Date.now() - msg.createdTimestamp;
    const pingEmbed = new EmbedBuilder()
      .setTitle("🏓 Pong!")
      .setColor(0x00ff00)
      .setDescription(`Latency: ${latency}ms`);
    return msg.reply({ embeds: [pingEmbed] });
  }
});

// ==================== INIT ====================
(async () => {
  await initDB();
  await client.login(DISCORD_TOKEN);
})();
