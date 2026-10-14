# ClickUp board

A [Shikidan](https://github.com/LynchzDEV/shiki) plugin. See a ClickUp board and start a chat or terminal on any task, with the task already explained to the AI.

## Install

In Shikidan: sidebar, Marketplace, add `https://github.com/LynchzDEV/skd-marketplace`, then install **ClickUp board**.

It runs **isolated**. It can reach `api.clickup.com` and nothing else, start chats and terminals only when you click Start on a task, and keep its own settings. It cannot read your files or Shikidan's other secrets.

## Use

1. Paste a ClickUp personal token (ClickUp, Settings, Apps, Generate). It stays on this machine.
2. Add a board: browse Workspace → Space → Folder → List, or paste a list or board-view link. Give it a folder, the repo sessions should open in.
3. Hover a task card and click **Start chat** or **Start terminal**. The launcher opens with the board's folder, and the AI first reads a dossier of the task: description, subtasks, comments and replies, linked tasks, custom fields and attachment links.

The board refreshes when you open it or click Refresh. Nothing polls in the background, and nothing is ever written back to ClickUp.

## Limits

- ClickUp allows 100 requests a minute per token. When it is busy the board says so and when to try again.
- A dossier stops at 60 tasks, the newest 200 comments per task, and about 25 seconds; it says when it stopped early.
- Pasted board views keep their filters only when ClickUp's view-tasks API is available to your account; otherwise the board shows the whole list and says so.

## Develop

```sh
bun install
bun test
```

Server methods are in `src/server.ts`, the screen in `src/screen.ts`. Built with [skd-plugin-sdk](https://github.com/LynchzDEV/skd-plugin-sdk).
