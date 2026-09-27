# PokeMarket QuickSet Discord Bot

Railway-ready Discord bot for publishing Pokémon TCG sets from TCGdex into a Discord Forum channel.

## Commands

### `/quickset`
1. Choose English, Chinese (Traditional), or Japanese.
2. Choose a Discord Forum channel.
3. The bot fetches TCGdex sets in oldest → newest release-date order.
4. It creates exactly one Forum post/thread per set.
5. Each set post contains set details, logo, release date, card counts, language, and a sort menu.
6. Choose A–Z, Z–A, card number ascending/descending, or rarity ascending/descending.
7. The bot fetches full card records so rarity is available, sorts them, and posts the cards in batches of 10 embeds per Discord message. Each card shows name, number, rarity, and its high-quality image.

### `/set continue`
1. Choose a language and Forum channel.
2. The bot scans existing QuickSet Forum posts using the `[TCGDEX:<set id>]` marker.
3. Missing sets are listed/flagged.
4. Missing sets are then posted oldest → newest.

## Environment variables

```env
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_client_id
GUILD_ID=your_server_id
```

`GUILD_ID` is recommended while testing because slash commands register immediately in one server. Leave it out for global command registration.

## Railway

Railway detects the included `railway.json`.

Build: `npm ci && npm run build`
Start: `npm start`

Add the three variables under Railway → Variables.

## Discord permissions

The bot needs permission to view the selected forum, send messages, embed links, create public threads/posts, and send messages in threads.

## TCGdex

This uses the official TCGdex REST API. Chinese is mapped to `zh-tw` (Traditional Chinese). TCGdex card responses contain rarity and pricing data; this version posts the fields requested above and does not post market prices.
