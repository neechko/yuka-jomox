import axios from "axios";
import { EmbedBuilder } from "discord.js";

const GENIUS_TOKEN = process.env.GENIUS_TOKEN;

async function isTokenValid() {
  try {
    const res = await axios.get("https://api.genius.com", {
      headers: { Authorization: `Bearer ${GENIUS_TOKEN}` }
    });
    return true;
  } catch (err) {
    console.error("❌ Token Genius tidak valid:", err.response?.status, err.message);
    return false;
  }
}

export async function handleLyricsCommand(msg, PREFIX) {
  const content = msg.content.trim();
  const query = content.slice(`${PREFIX}lyrics`.length).trim();

  if (!query) return msg.reply("❌ Tulis judul lagu setelah command ?lyrics");

  const thinkingMsg = await msg.reply("⏳ Mengecek token Genius...");

  // 1️⃣ Cek token Genius
  const valid = await isTokenValid();
  if (!valid) return thinkingMsg.edit("❌ Token Genius tidak valid. Silakan periksa GENIUS_TOKEN di .env");

  try {
    // 2️⃣ Search lagu di Genius
    const searchRes = await axios.get(
      `https://api.genius.com/search?q=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${GENIUS_TOKEN}` } }
    );

    const hits = searchRes.data.response.hits;
    if (!hits.length) return thinkingMsg.edit("❌ Lagu tidak ditemukan di Genius.");

    const song = hits[0].result;
    const songUrl = song.url;

    // 3️⃣ Ambil halaman HTML untuk scrape lirik
    const pageRes = await axios.get(songUrl);
    const html = pageRes.data;

    // 4️⃣ Ambil lirik dari HTML (fallback)
    let lyricsMatch = html.match(/<div class="lyrics">([\s\S]*?)<\/div>/) ||
                      html.match(/<div class="Lyrics__Root-sc-\w+">([\s\S]*?)<\/div>/);
    let lyrics = lyricsMatch ? lyricsMatch[1] : html.replace(/<[^>]*>?/gm, "").slice(0, 4000);

    lyrics = lyrics.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>?/gm, "").trim();
    if (lyrics.length > 4000) lyrics = lyrics.slice(0, 4000) + "\n…(truncated)";

    // 5️⃣ Kirim embed ke Discord
    const embed = new EmbedBuilder()
      .setTitle(`🎵 ${song.full_title}`)
      .setURL(songUrl)
      .setDescription(lyrics || "❌ Lirik tidak tersedia")
      .setColor(0xff00ff)
      .setFooter({ text: "Lyrics powered by Genius" })
      .setTimestamp();

    return thinkingMsg.edit({ content: null, embeds: [embed] });

  } catch (err) {
    console.error("❌ Error fetch Genius:", err.response?.status, err.message);
    return thinkingMsg.edit(`❌ Error fetch Genius: ${err.response?.status || err.message}`);
  }
}
