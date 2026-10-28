// Bot moderare Discord - discord.js v14 + SQLite (totul gratuit)
// Pornire: npm install && npm start   (vezi .env.example)

const Database = require("better-sqlite3");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  ChannelType,
} = require("discord.js");

const PREFIX = ",";
const TOKEN = process.env.TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null; // copie a tuturor actiunilor de moderare
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID || null; // unde se posteaza statistica voice
const VOICE_INTERVAL_MIN = Number(process.env.VOICE_INTERVAL_MIN || 30);
const COLOR = 0x5b3fd1;

// Roluri care au voie sa foloseasca comenzile de moderare (ID-uri separate prin virgula).
// Gol = se folosesc permisiunile normale de Discord (Ban Members, Kick Members etc.).
const ALLOWED_ROLE_IDS = (process.env.ALLOWED_ROLE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Roluri per comanda (optional): BAN_ROLE_IDS, KICK_ROLE_IDS, WARN_ROLE_IDS
const cmdRoles = (name) =>
  (process.env[`${name}_ROLE_IDS`] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// ---------- baza de date (fisier local, gratis) ----------
const db = new Database("bot.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS warns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    mod_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
const addWarn = db.prepare(
  "INSERT INTO warns (guild_id,user_id,mod_id,reason,created_at) VALUES (?,?,?,?,?)"
);
const countWarns = db.prepare(
  "SELECT COUNT(*) AS n FROM warns WHERE guild_id=? AND user_id=?"
);
const listWarns = db.prepare(
  "SELECT * FROM warns WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT 10"
);
const deleteWarn = db.prepare("DELETE FROM warns WHERE id=? AND guild_id=?");
const clearWarns = db.prepare("DELETE FROM warns WHERE guild_id=? AND user_id=?");

// ---------- client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------- helperi ----------
function modEmbed({ title, user, moderator, reason, extra = [] }) {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(title)
    .addFields(
      { name: "Membru", value: `<@${user.id}>\n\`${user.id}\``, inline: true },
      { name: "Moderator", value: `<@${moderator.id}>\n\`${moderator.id}\``, inline: true },
      ...extra,
      { name: "Motiv", value: reason }
    )
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: client.user.username })
    .setTimestamp();
}

// trimite embed-ul in canalul curent + copie in canalul de loguri
async function sendAndLog(msg, embed) {
  await msg.channel.send({ embeds: [embed] });
  if (LOG_CHANNEL_ID && LOG_CHANNEL_ID !== msg.channel.id) {
    const ch = await msg.guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (ch) ch.send({ embeds: [embed] }).catch(() => {});
  }
}

// Acces: Administratorul are mereu voie. Daca ai setat roluri pentru comanda
// (ex. BAN_ROLE_IDS) sau roluri generale (ALLOWED_ROLE_IDS), conteaza DOAR rolurile.
// Daca nu ai setat nimic, se folosesc permisiunile normale de Discord.
function hasPerm(msg, flag, group) {
  if (msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  const roles = [...(group ? cmdRoles(group) : []), ...ALLOWED_ROLE_IDS];
  if (roles.length > 0) return msg.member.roles.cache.some((r) => roles.includes(r.id));
  return msg.member.permissions.has(flag);
}

function voiceEmbed(guild) {
  const channels = guild.channels.cache.filter(
    (c) =>
      (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice) &&
      c.members.size > 0
  );
  const total = channels.reduce((a, c) => a + c.members.size, 0);
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("Voice")
    .setDescription(`**${total}** membri in **${channels.size}** canale voice.`)
    .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: client.user.username })
    .setTimestamp();
}

// ---------- statistica voice automata ----------
let lastVoiceMsg = null;
async function postVoiceStats() {
  if (!VOICE_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(VOICE_CHANNEL_ID);
    if (!ch) return;
    if (lastVoiceMsg) await lastVoiceMsg.delete().catch(() => {});
    lastVoiceMsg = await ch.send({ embeds: [voiceEmbed(ch.guild)] });
  } catch (e) {
    console.error("Eroare voice stats:", e.message);
  }
}

client.once("ready", () => {
  console.log(`Online ca ${client.user.tag}`);
  if (VOICE_CHANNEL_ID) {
    postVoiceStats();
    setInterval(postVoiceStats, VOICE_INTERVAL_MIN * 60 * 1000);
  }
});

// ---------- comenzi ----------
client.on("messageCreate", async (msg) => {
  if (msg.author.bot || !msg.guild || !msg.content.startsWith(PREFIX)) return;

  const args = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();

  try {
    // ,ban @user motiv
    if (cmd === "ban") {
      if (!hasPerm(msg, PermissionsBitField.Flags.BanMembers, "BAN"))
        return msg.reply("Nu ai permisiunea de a bana.");
      const target = msg.mentions.members.first();
      if (!target) return msg.reply("Foloseste: `,ban @user motiv`");
      if (!target.bannable) return msg.reply("Nu pot bana acest membru.");
      const reason = args.slice(1).join(" ") || "Fara motiv";
      await target.ban({ reason: `${msg.author.tag}: ${reason}` });
      return sendAndLog(
        msg,
        modEmbed({ title: "Membru banat", user: target.user, moderator: msg.author, reason })
      );
    }

    // ,unban ID motiv
    if (cmd === "unban") {
      if (!hasPerm(msg, PermissionsBitField.Flags.BanMembers, "BAN"))
        return msg.reply("Nu ai permisiunea de a debana.");
      const id = args[0];
      if (!id || !/^\d{17,20}$/.test(id)) return msg.reply("Foloseste: `,unban ID motiv`");
      const reason = args.slice(1).join(" ") || "Fara motiv";
      const ban = await msg.guild.bans.fetch(id).catch(() => null);
      if (!ban) return msg.reply("Acest ID nu este banat.");
      await msg.guild.members.unban(id, `${msg.author.tag}: ${reason}`);
      return sendAndLog(
        msg,
        modEmbed({ title: "Membru debanat", user: ban.user, moderator: msg.author, reason })
      );
    }

    // ,kick @user motiv
    if (cmd === "kick") {
      if (!hasPerm(msg, PermissionsBitField.Flags.KickMembers, "KICK"))
        return msg.reply("Nu ai permisiunea de a da kick.");
      const target = msg.mentions.members.first();
      if (!target) return msg.reply("Foloseste: `,kick @user motiv`");
      if (!target.kickable) return msg.reply("Nu pot da kick acestui membru.");
      const reason = args.slice(1).join(" ") || "Fara motiv";
      await target.kick(`${msg.author.tag}: ${reason}`);
      return sendAndLog(
        msg,
        modEmbed({ title: "Membru dat afara", user: target.user, moderator: msg.author, reason })
      );
    }

    // ,warn @user motiv
    if (cmd === "warn") {
      if (!hasPerm(msg, PermissionsBitField.Flags.ModerateMembers, "WARN"))
        return msg.reply("Nu ai permisiunea de a da warn.");
      const target = msg.mentions.members.first();
      if (!target) return msg.reply("Foloseste: `,warn @user motiv`");
      const reason = args.slice(1).join(" ") || "Fara motiv";
      addWarn.run(msg.guild.id, target.id, msg.author.id, reason, Date.now());
      const total = countWarns.get(msg.guild.id, target.id).n;
      return sendAndLog(
        msg,
        modEmbed({
          title: "Warn adaugat",
          user: target.user,
          moderator: msg.author,
          reason,
          extra: [{ name: "Warn", value: `**#${total}** din **${total}**`, inline: true }],
        })
      );
    }

    // ,warns @user
    if (cmd === "warns") {
      if (!hasPerm(msg, PermissionsBitField.Flags.ModerateMembers, "WARN"))
        return msg.reply("Nu ai permisiunea.");
      const target = msg.mentions.users.first() || msg.author;
      const rows = listWarns.all(msg.guild.id, target.id);
      const total = countWarns.get(msg.guild.id, target.id).n;
      const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(`Warn-uri: ${target.username}`)
        .setThumbnail(target.displayAvatarURL({ size: 256 }))
        .setDescription(
          rows.length
            ? rows
                .map(
                  (w) =>
                    `**ID ${w.id}** - ${w.reason}\n<t:${Math.floor(w.created_at / 1000)}:d> de <@${w.mod_id}>`
                )
                .join("\n\n")
            : "Niciun warn."
        )
        .setFooter({ text: `Total: ${total}` });
      return msg.channel.send({ embeds: [embed] });
    }

    // ,unwarn ID
    if (cmd === "unwarn") {
      if (!hasPerm(msg, PermissionsBitField.Flags.ModerateMembers, "WARN"))
        return msg.reply("Nu ai permisiunea.");
      const id = Number(args[0]);
      if (!id) return msg.reply("Foloseste: `,unwarn ID` (ID-ul il vezi cu `,warns @user`)");
      const r = deleteWarn.run(id, msg.guild.id);
      return msg.reply(r.changes ? `Warn-ul ${id} a fost sters.` : "Nu exista warn cu acest ID.");
    }

    // ,clearwarns @user
    if (cmd === "clearwarns") {
      if (!hasPerm(msg, PermissionsBitField.Flags.ModerateMembers, "WARN"))
        return msg.reply("Nu ai permisiunea.");
      const target = msg.mentions.users.first();
      if (!target) return msg.reply("Foloseste: `,clearwarns @user`");
      const r = clearWarns.run(msg.guild.id, target.id);
      return msg.reply(`Am sters ${r.changes} warn-uri pentru ${target.username}.`);
    }

    // ,voice
    if (cmd === "voice") {
      return msg.channel.send({ embeds: [voiceEmbed(msg.guild)] });
    }
  } catch (e) {
    console.error(e);
    msg.reply("A aparut o eroare la executarea comenzii.").catch(() => {});
  }
});

client.login(TOKEN);
