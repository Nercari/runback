# Mentor workspace template

Template for the folder mentor chats run in (`wow-mentor/`). It holds no personal data; the live copy does.

Set up once:
1. Start the bridge. With no other folder chosen it copies this template to `wow-mentor` (a sibling of the repo) and every chat works there by default.
2. Copy `LOCAL.example.md` to `LOCAL.md` and fill in the paths.

The bridge treats chats in that folder as mentor chats (write access limited to this folder). A chat moved elsewhere comes back with `/runback cd <path to wow-mentor>`.

Folders the agent creates as needed: `characters/`, `reviews/`, `reports/`, `forever-facts/`, `journal/`, `bulk/`, `addon-staging/`.
