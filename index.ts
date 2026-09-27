import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  Events,
  ForumChannel,
  GatewayIntentBits,
  Interaction,
  REST,
  Routes,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ThreadChannel,
  type APIEmbedField,
  type TextChannel,
} from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID) throw new Error('Missing DISCORD_TOKEN or CLIENT_ID');

const API_BASE = 'https://api.tcgdex.net/v2';
const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  'zh-tw': 'Chinese',
  ja: 'Japanese',
};

type TcgLanguage = keyof typeof LANGUAGE_LABELS;
type SortKey = 'name' | 'number' | 'rarity';
type SortOrder = 'asc' | 'desc';

interface SetBrief {
  id: string;
  name: string;
  logo?: string;
  symbol?: string;
  cardCount?: { total?: number; official?: number };
  releaseDate?: string;
  serie?: { id?: string; name?: string };
}

interface SetData extends SetBrief {
  releaseDate?: string;
  serie?: { id: string; name: string };
  cards?: Array<{ id: string; localId: string | number; name: string; image?: string }>;
}

interface CardData {
  id: string;
  localId: string | number;
  name: string;
  image?: string;
  rarity?: string;
  category?: string;
  hp?: string | number;
  types?: string[];
  stage?: string;
  illustrator?: string;
  englishName?: string;
  attacks?: Array<{ name?: string; cost?: string[]; damage?: string | number; effect?: string }>;
  weaknesses?: Array<{ type?: string; value?: string | number }>;
  resistances?: Array<{ type?: string; value?: string | number }>;
  retreat?: number;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tcgdex<T>(lang: TcgLanguage, path: string): Promise<T> {
  const url = `${API_BASE}/${lang}/${path.replace(/^\//, '')}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { headers: { 'User-Agent': 'PokeMarket-QuickSet/1.0' } });
    if (response.ok) return (await response.json()) as T;
    if (response.status === 429 || response.status >= 500) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    const body = await response.text();
    throw new Error(`TCGdex ${response.status}: ${body.slice(0, 300)}`);
  }
  throw new Error(`TCGdex request failed after retries: ${path}`);
}

async function getSets(lang: TcgLanguage): Promise<SetBrief[]> {
  // TCGdex's default set ordering is releaseDate > localId > id, but we ask explicitly
  // for releaseDate ASC so QuickSet always starts with the oldest sets.
  return tcgdex<SetBrief[]>(lang, 'sets?sort:field=releaseDate&sort:order=ASC');
}

async function getSet(lang: TcgLanguage, id: string): Promise<SetData> {
  return tcgdex<SetData>(lang, `sets/${encodeURIComponent(id)}`);
}

async function getCard(lang: TcgLanguage, id: string): Promise<CardData> {
  return tcgdex<CardData>(lang, `cards/${encodeURIComponent(id)}`);
}

function languageSelect(customId: string) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Choose a language')
      .addOptions(
        { label: 'English', value: 'en', emoji: '🇬🇧' },
        { label: 'Chinese', value: 'zh-tw', emoji: '🇨🇳' },
        { label: 'Japanese', value: 'ja', emoji: '🇯🇵' },
      ),
  );
}

function forumSelect(customId: string) {
  return new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Choose the forum to post the sets in')
      .setChannelTypes(ChannelType.GuildForum),
  );
}

function sortSelect(customId: string) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Choose how to sort the cards')
      .addOptions(
        { label: 'A–Z ascending', value: 'name:asc' },
        { label: 'Z–A descending', value: 'name:desc' },
        { label: 'Card number ascending', value: 'number:asc' },
        { label: 'Card number descending', value: 'number:desc' },
        { label: 'Rarity ascending', value: 'rarity:asc' },
        { label: 'Rarity descending', value: 'rarity:desc' },
      ),
  );
}

const englishSetCache = new Map<string, string>();

// TCGdex serves localized set names, but a Japanese/Chinese set does not
// necessarily have a one-to-one English set entry. For forum titles we need
// the English translation of the native name, not an unrelated English set
// that happens to share an ID. Keep exact translations for common official
// names and use the translation service as a fallback for newer sets.
const SET_TRANSLATIONS: Record<string, string> = {
  '未来の一閃': 'Future Flash',
  '古代の咆哮': 'Ancient Roar',
  'ロケット団の栄光': 'Glory of Team Rocket',
  '火箭队的荣耀': 'Glory of Team Rocket',
  '火箭隊的榮耀': 'Glory of Team Rocket',
};

async function translateNativeSetName(nativeName: string, language: TcgLanguage): Promise<string> {
  if (language === 'en') return nativeName;
  const exact = SET_TRANSLATIONS[nativeName.trim()];
  if (exact) return exact;

  const cacheKey = `${language}:translation:${nativeName}`;
  const cached = englishSetCache.get(cacheKey);
  if (cached) return cached;

  // Google Translate's public translation endpoint is used only as a fallback
  // for set names that are not in the exact-name map above. This keeps the bot
  // current as new Japanese/Chinese expansions are added.
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(nativeName)}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'PokeMarket-QuickSet/1.0' } });
    if (response.ok) {
      const data = await response.json() as unknown;
      const translated = Array.isArray(data) && Array.isArray(data[0])
        ? (data[0] as unknown[])
          .filter((part): part is unknown[] => Array.isArray(part))
          .map((part) => String(part[0] ?? ''))
          .join('')
          .trim()
        : '';
      if (translated) {
        englishSetCache.set(cacheKey, translated);
        return translated;
      }
    }
  } catch {
    // Fall through to a visible placeholder rather than repeating the native name.
  }

  return 'English translation unavailable';
}

async function getEnglishSetName(set: SetData, language: TcgLanguage): Promise<string> {
  if (language === 'en') return set.name;

  // Always translate the native title. Do NOT use the English API set with the
  // same ID because Japanese/Chinese IDs can refer to a different expansion
  // (for example Japanese SV10 is Glory of Team Rocket while English SV10 is
  // Destined Rivals).
  return translateNativeSetName(set.name, language);
}

async function threadName(index: number, set: SetData, language: TcgLanguage) {
  // Forum titles never expose the internal TCGdex ID/marker. Japanese and
  // Chinese posts show the native title followed by its English translation.
  const nativeName = set.name;
  const englishName = await getEnglishSetName(set, language);
  const title = language === 'en' || englishName === nativeName
    ? nativeName
    : `${nativeName} — ${englishName}`;
  return `${String(index + 1).padStart(3, '0')} • ${title}`.slice(0, 100);
}

function isLegacyQuickSetThread(thread: ThreadChannel) {
  return /\[TCGDEX:[^\]]+\]$/.test(thread.name);
}

function extractLegacySetId(thread: ThreadChannel): string | null {
  const match = thread.name.match(/\[TCGDEX:([^\]]+)\]$/);
  return match?.[1] ?? null;
}

async function getQuickSetSetId(thread: ThreadChannel): Promise<string | null> {
  // Keep old posts compatible, but new posts are identified from their embed.
  const legacy = extractLegacySetId(thread);
  if (legacy) return legacy;

  try {
    const starter = await thread.fetchStarterMessage();
    if (!starter) return null;
    const embed = starter.embeds[0];
    if (!embed) return null;
    const field = embed.fields.find((f) => f.name.toLowerCase() === 'set id');
    return field?.value?.replace(/`/g, '').trim() || null;
  } catch {
    return null;
  }
}

function setEmbed(set: SetData, language: TcgLanguage, index: number, total: number) {
  const fields: APIEmbedField[] = [
    { name: 'Set', value: set.name || set.id, inline: true },
    { name: 'Set ID', value: `\`${set.id}\``, inline: true },
    { name: 'Series', value: set.serie?.name ?? 'Unknown', inline: true },
    { name: 'Release date', value: set.releaseDate ?? 'Unknown', inline: true },
    { name: 'Cards', value: `${set.cardCount?.official ?? '?'} official / ${set.cardCount?.total ?? '?'} total`, inline: true },
    { name: 'Language', value: LANGUAGE_LABELS[language], inline: true },
  ];

  const embed = new EmbedBuilder()
    .setTitle(`${set.name} — Card List`)
    .setDescription(`Set **${index + 1} of ${total}**\nChoose a sort below to publish the cards in this post.`)
    .addFields(fields)
    .setFooter({ text: 'Data and images: TCGdex' });
  if (set.logo ?? set.symbol) embed.setThumbnail(set.logo ?? set.symbol!);
  return embed;
}

function cardImageUrl(image?: string, language?: TcgLanguage, set?: SetData, localId?: string | number) {
  if (image) {
    // TCGdex commonly returns an asset URL without an extension.
    // Use an explicit high-quality PNG so Discord reliably renders localized
    // Japanese/Chinese scans as well as English scans.
    if (/\.(png|jpe?g|webp)(\?.*)?$/i.test(image)) return image;
    return `${image}/high.png`;
  }

  // Some localized TCGdex card records do not currently include an `image`
  // field even though the scan exists in the assets service. Reconstruct the
  // documented asset path from the set's series/set/local card ID so those
  // cards still get an image in Discord.
  if (language && set && localId !== undefined) {
    const serieId = set.serie?.id;
    if (serieId) {
      const assetLanguage = language;
      return `https://assets.tcgdex.net/${assetLanguage}/${encodeURIComponent(serieId)}/${encodeURIComponent(set.id)}/${encodeURIComponent(String(localId))}/high.png`;
    }
  }

  return undefined;
}

function cardEmbed(card: CardData, language?: TcgLanguage, set?: SetData) {
  const fields: APIEmbedField[] = [
    { name: 'Number', value: String(card.localId), inline: true },
    { name: 'Rarity', value: card.rarity ?? 'Unknown', inline: true },
    { name: 'Type', value: card.types?.length ? card.types.join(', ') : 'Unknown', inline: true },
    { name: 'Stage', value: card.stage ?? 'Unknown', inline: true },
    { name: 'Illustrator', value: card.illustrator ?? 'Unknown', inline: true },
  ];

  const nativeName = card.name || 'Unknown card';
  const title = language && language !== 'en' && card.englishName && card.englishName !== nativeName
    ? `${nativeName} — ${card.englishName}`
    : nativeName;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .addFields(fields);

  const imageUrl = cardImageUrl(card.image, language, set, card.localId);
  if (imageUrl) embed.setImage(imageUrl);
  return embed;
}

function sortCards(cards: CardData[], key: SortKey, order: SortOrder) {
  const direction = order === 'asc' ? 1 : -1;
  return [...cards].sort((a, b) => {
    if (key === 'name') return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }) * direction;
    if (key === 'rarity') return (a.rarity ?? 'Unknown').localeCompare(b.rarity ?? 'Unknown', undefined, { sensitivity: 'base' }) * direction;
    return compareCardNumber(String(a.localId), String(b.localId)) * direction;
  });
}

function compareCardNumber(a: string, b: string) {
  const parse = (v: string): readonly [number, string] => {
    const m = v.match(/^(\d+)(.*)$/);
    return m ? [Number(m[1]), m[2]] as const : [Number.MAX_SAFE_INTEGER, v];
  };
  const [an, as] = parse(a);
  const [bn, bs] = parse(b);
  return an - bn || as.localeCompare(bs, undefined, { numeric: true });
}

async function fetchFullCards(lang: TcgLanguage, set: SetData) {
  const briefs = set.cards ?? [];
  const cards: CardData[] = [];
  const concurrency = 6;
  let cursor = 0;

  async function worker() {
    while (cursor < briefs.length) {
      const i = cursor++;
      const brief = briefs[i];
      try {
        const full = await getCard(lang, brief.id);
        // TCGdex uses the same card IDs across supported languages, so for
        // Japanese/Chinese cards fetch the English record using the exact same
        // ID. This gives us the official English card name instead of relying
        // on machine translation (e.g. ジャンプラフ -> Jumpluff).
        let englishName = full.name;
        if (lang !== 'en') {
          try {
            const english = await getCard('en', brief.id);
            englishName = english.name || full.name;
          } catch {
            englishName = await translateNativeSetName(full.name, lang);
          }
        }
        // TCGdex card detail normally includes the image, but keep the image
        // from the set's card brief as a guaranteed fallback.
        cards[i] = { ...full, englishName, image: full.image ?? brief.image };
      } catch (error) {
        console.error(`Card fetch failed ${brief.id}:`, error);
        cards[i] = { ...brief, rarity: 'Unknown', englishName: lang === 'en' ? brief.name : await translateNativeSetName(brief.name, lang) };
      }
      await sleep(75);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, briefs.length) }, worker));
  return cards.filter(Boolean);
}

async function sendPrivateCardPages(interaction: StringSelectMenuInteraction, cards: CardData[], set: SetData, key: SortKey, order: SortOrder) {
  const setLanguage = (interaction.customId.split(':')[2] || 'en') as TcgLanguage;
  // Discord allows up to 10 embeds per message. These are sent as ephemeral
  // interaction responses/follow-ups, so only the person who chose the sort sees them.
  for (let i = 0; i < cards.length; i += 10) {
    const chunk = cards.slice(i, i + 10);
    const page = Math.floor(i / 10) + 1;
    const totalPages = Math.ceil(cards.length / 10);
    const content = `📚 **${set.name}** — ${cards.length} cards\nSort: **${sortLabel(key, order)}**\nPage **${page}/${totalPages}**`;
    if (i === 0) {
      await interaction.editReply({ content, embeds: chunk.map((card) => cardEmbed(card, setLanguage, set)), components: [] });
    } else {
      await interaction.followUp({ content, embeds: chunk.map((card) => cardEmbed(card, setLanguage, set)), ephemeral: true });
    }
    await sleep(150);
  }
}

async function findForumThreads(forum: ForumChannel): Promise<ThreadChannel[]> {
  const candidates = new Map<string, ThreadChannel>();
  const active = await forum.threads.fetchActive();
  for (const thread of active.threads.values()) candidates.set(thread.id, thread);

  let before: string | undefined;
  for (let page = 0; page < 50; page++) {
    const archived = await forum.threads.fetchArchived({ type: 'public', limit: 100, before });
    for (const thread of archived.threads.values()) candidates.set(thread.id, thread);
    if (!archived.hasMore || archived.threads.size === 0) break;
    const oldest = [...archived.threads.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0))[0];
    if (!oldest) break;
    before = oldest.id;
  }

  const quickSets: ThreadChannel[] = [];
  for (const thread of candidates.values()) {
    if (await getQuickSetSetId(thread)) quickSets.push(thread);
  }
  return quickSets;
}

async function getExistingSetIds(forum: ForumChannel) {
  const threads = await findForumThreads(forum);
  const ids = await Promise.all(threads.map(getQuickSetSetId));
  return new Set(ids.filter((x): x is string => Boolean(x)));
}

async function postSet(forum: ForumChannel, set: SetData, language: TcgLanguage, index: number, total: number) {
  const thread = await forum.threads.create({
    name: await threadName(index, set, language),
    message: {
      embeds: [setEmbed(set, language, index, total)],
      components: [sortSelect(`quickset:sort:${language}:${set.id}`)],
    },
    reason: `QuickSet ${LANGUAGE_LABELS[language]} — ${set.name}`,
  });
  return thread;
}

async function startQuickSet(interaction: ChatInputCommandInteraction) {
  await interaction.reply({
    content: '**QuickSet setup — step 1/2**\nChoose the language to use for the set and card names.',
    components: [languageSelect('quickset:language')],
    ephemeral: true,
  });
}

async function handleQuickSetLanguage(interaction: StringSelectMenuInteraction) {
  const language = interaction.values[0] as TcgLanguage;
  await interaction.update({
    content: `**QuickSet setup — step 2/2**\nLanguage: **${LANGUAGE_LABELS[language]}**\nNow choose the forum.`,
    components: [forumSelect(`quickset:forum:${language}`)],
  });
}

async function safeEdit(interaction: any, content: string) {
  try { await interaction.editReply(content); } catch (error) { console.warn('Interaction update skipped:', error); }
}

async function runQuickSet(interaction: any, language: TcgLanguage, forum: ForumChannel) {
  await interaction.update({
    content: `⏳ Starting QuickSet in **${forum.name}** using **${LANGUAGE_LABELS[language]}**.\nFetching the set list from TCGdex…`,
    components: [],
  });

  const sets = await getSets(language);
  let posted = 0;
  let failed = 0;

  for (let i = 0; i < sets.length; i++) {
    const brief = sets[i];
    try {
      const full = await getSet(language, brief.id);
      await postSet(forum, full, language, i, sets.length);
      posted++;
      await sleep(300);
      if (posted % 10 === 0) {
        await safeEdit(interaction, `⏳ QuickSet is posting sets… **${posted}/${sets.length}** created.`);
      }
    } catch (error) {
      failed++;
      console.error(`Failed to post set ${brief.id}:`, error);
    }
  }

  await interaction.editReply(
    `✅ **QuickSet complete**\nCreated **${posted}** set posts in ${forum}.` +
      (failed ? `\n⚠️ **${failed}** sets failed and can be recovered with **/set continue**.` : '') +
      `\n\nEach set post has its own sort menu.`,
  );
}

async function continueSets(interaction: ChatInputCommandInteraction) {
  await interaction.reply({
    content: '**Continue setup — step 1/2**\nChoose the language used by the set posts you want to continue.',
    components: [languageSelect('continue:language')],
    ephemeral: true,
  });
}

async function handleContinueLanguage(interaction: StringSelectMenuInteraction) {
  const language = interaction.values[0] as TcgLanguage;
  await interaction.update({
    content: `**Continue setup — step 2/2**\nLanguage: **${LANGUAGE_LABELS[language]}**\nChoose the forum to scan and continue.`,
    components: [forumSelect(`continue:forum:${language}`)],
  });
}

async function runContinue(interaction: any, language: TcgLanguage, forum: ForumChannel) {
  await interaction.update({
    content: `🔎 Checking ${forum} for existing TCGdex set posts…`,
    components: [],
  });

  const [sets, existing] = await Promise.all([getSets(language), getExistingSetIds(forum)]);
  const missing = sets.filter((set) => !existing.has(set.id));

  if (!missing.length) {
    await safeEdit(interaction, `✅ No missing sets found. All **${sets.length}** TCGdex sets are already flagged in ${forum}.`);
    return;
  }

  const preview = missing.slice(0, 15).map((s) => `• ${s.name} \`${s.id}\``).join('\n');
  await interaction.editReply(
    `🚩 **${missing.length} sets are missing from ${forum}.**\n\n${preview}` +
      (missing.length > 15 ? `\n…and ${missing.length - 15} more.` : '') +
      `\n\nContinuing in oldest → newest order…`,
  );

  let posted = 0;
  let failed = 0;
  const total = sets.length;

  for (const brief of missing) {
    const originalIndex = sets.findIndex((s) => s.id === brief.id);
    try {
      const full = await getSet(language, brief.id);
      await postSet(forum, full, language, originalIndex, total);
      posted++;
      await sleep(300);
      if (posted % 10 === 0) await interaction.editReply(`⏳ Continuing… **${posted}/${missing.length}** missing set posts created.`);
    } catch (error) {
      failed++;
      console.error(`Continue failed ${brief.id}:`, error);
    }
  }

  await interaction.editReply(
    `✅ **Continue complete**\nAdded **${posted}** missing set posts.` +
      (failed ? `\n⚠️ **${failed}** failed; run **/set continue** again after checking permissions/API access.` : ''),
  );
}

async function handleSort(interaction: StringSelectMenuInteraction) {
  const [, , languageRaw, setId] = interaction.customId.split(':');
  const language = languageRaw as TcgLanguage;
  const [key, order] = interaction.values[0].split(':') as [SortKey, SortOrder];
  const thread = interaction.channel;

  if (!thread?.isThread()) {
    await interaction.reply({ content: 'This menu can only be used inside a QuickSet forum post.', ephemeral: true });
    return;
  }

  // Everything produced by the sort menu is private to the person who selected it.
  await interaction.deferReply({ ephemeral: true });

  try {
    const set = await getSet(language, setId);
    const cards = sortCards(await fetchFullCards(language, set), key, order);
    await sendPrivateCardPages(interaction, cards, set, key, order);
  } catch (error) {
    console.error(error);
    await interaction.editReply({ content: '❌ I could not load this set from TCGdex. Check the bot logs and try again.' });
  }
}

function sortLabel(key: SortKey, order: SortOrder) {
  if (key === 'name') return order === 'asc' ? 'A–Z ascending' : 'Z–A descending';
  if (key === 'number') return order === 'asc' ? 'Card number ascending' : 'Card number descending';
  return order === 'asc' ? 'Rarity ascending' : 'Rarity descending';
}

async function registerCommands() {
  const commands = [
    {
      name: 'quickset',
      description: 'Post one TCGdex forum post for every Pokémon TCG set.',
    },
    {
      name: 'set',
      description: 'Manage TCGdex set posts.',
      options: [
        {
          type: 1,
          name: 'continue',
          description: 'Find and post any TCGdex sets missing from a forum.',
        },
      ],
    },
  ];

  const rest = new REST({ version: '10' }).setToken(TOKEN!);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID!, GUILD_ID), { body: commands });
    console.log(`Registered commands in guild ${GUILD_ID}`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID!), { body: commands });
    console.log('Registered global commands');
  }
}

client.once(Events.ClientReady, async (ready) => {
  console.log(`Logged in as ${ready.user.tag}`);
  try {
    await registerCommands();
  } catch (error) {
    console.error('Command registration failed:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'quickset') return startQuickSet(interaction);
      if (interaction.commandName === 'set' && interaction.options.getSubcommand() === 'continue') return continueSets(interaction);
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'quickset:language') return handleQuickSetLanguage(interaction);
      if (interaction.customId.startsWith('continue:language')) return handleContinueLanguage(interaction);
      if (interaction.customId.startsWith('quickset:sort:')) return handleSort(interaction);
    }

    if (interaction.isChannelSelectMenu()) {
      const [, mode, language] = interaction.customId.split(':');
      const channel = interaction.channels.first();
      if (!channel || channel.type !== ChannelType.GuildForum) {
        await interaction.reply({ content: 'Please choose a forum channel.', ephemeral: true });
        return;
      }
      if (mode === 'forum' && interaction.customId.startsWith('quickset:')) {
        return runQuickSet(interaction, language as TcgLanguage, channel as ForumChannel);
      }
      if (mode === 'forum' && interaction.customId.startsWith('continue:')) {
        return runContinue(interaction, language as TcgLanguage, channel as ForumChannel);
      }
    }
  } catch (error) {
    console.error('Interaction error:', error);
    if (interaction.isRepliable()) {
      const message = '❌ Something went wrong. Check the Railway logs for details.';
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
      else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
});

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

client.login(TOKEN);
