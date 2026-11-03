# ClickUp board

A [Shikidan](https://github.com/LynchzDEV/shiki) plugin. See a ClickUp board and start a chat or terminal on any task, with the task already explained to the AI.

## Install

In Shikidan: sidebar, Marketplace, add `https://github.com/LynchzDEV/skd-marketplace`, then install **ClickUp board**.

It runs **isolated**. It can reach `api.clickup.com` and nothing else, start chats and terminals only when you click Start on a task, and keep its own settings. It cannot read your files or Shikidan's other secrets.

## Use

1. Paste a ClickUp personal token (ClickUp, Settings, Apps, Generate). It stays on this machine.
2. Add a board: browse Workspace → Space → Folder → List, or paste a list or board-view link. Give it a folder, the repo sessions should open in.
3. Hover a task card and click **Start chat** or **Start terminal**. The launcher opens with the board's folder, and the AI first reads a dossier of the task: header (status, people, dates, priority, checklists), description, subtasks, comments and replies, linked tasks, custom fields, referenced ClickUp Docs, other links and a Coverage section naming every limit that cut something. `source.item` and `task.dossier` also download up to 30 inline and attached images (ClickUp attachment hosts only, 3.75 MB each) into the plugin data folder and return them as `images: [{ name, path }]`; Shikidan copies them next to the context.

The board refreshes when you open it or click Refresh. Nothing polls in the background. The only things written to ClickUp are comments Shikidan's queue posts (below).

## Queue source

`source.post` posts the questions Shikidan asks (`kind: 'ask'`) and update comments (`kind: 'update'`). An update is the given lines plus the `— Shikidan` marker, which also keeps it out of replies. It can carry `mention` (a ClickUp user id, or an exact username, exact email or unique username prefix on the task's list) as a real @mention (prefixes need 3+ characters), and `status` (a status of the task's list), and returns `{ commentId, status, warning }`. Once the comment exists the call never throws: a mention that cannot be resolved or kept becomes one plain `@name` comment, and anything that did not happen is described in `warning`.

## Limits

- ClickUp allows 100 requests a minute per token. When it is busy the board says so and when to try again.
- A dossier stops at 60 tasks, depth 3, the newest 200 comments per task, 5 Docs of 50 KB, 30 images, 512 KB and about 25 seconds; Coverage says which limit was hit.
- Pasted board views keep their filters only when ClickUp's view-tasks API is available to your account; otherwise the board shows the whole list and says so.

## Develop

```sh
bun install
bun test
```

Server methods are in `src/server.ts`, the screen in `src/screen.ts`. Built with [skd-plugin-sdk](https://github.com/LynchzDEV/skd-plugin-sdk).
