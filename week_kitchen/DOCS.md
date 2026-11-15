# Week Kitchen

A weekly meal planner that lives in the Home Assistant sidebar. Recipes, the week plan and
the page's settings are plain JSON files in `data_dir`, so anything that can write a file
(you, a script, an assistant with access to the folder) can add or edit recipes.

## Setup

1. **Settings → System → Storage → Add network storage**: usage *Share*, name `recipes`.
   It appears at `/share/recipes`. A *Media* mount works too, at `/media/<name>`; set `data_dir` to match.
2. Install and start the app, then open **Kitchen** in the sidebar.

## Data folder

```
data_dir/
  settings.json          optional: { "title", "accent", "tagline", "kid", "scoop" }
  week.json              written by the planner
  recipes/<id>.json      one recipe per file; <id> is lowercase letters, digits, - and _
```

A recipe: `name`, `short`, `serves`, `time`, `gear`, `ing[]`, `steps[]` (`h` title, `x` HTML
text, `heat` H/MH/M/ML/L/OFF/O350/O400/O425, `t` timer seconds, `kid` true for the "scoop a
portion" step), plus optional `kid` (note), `warn`, `leftovers`, `art`, `loved`, `lastCooked`.

The page may only change `loved` and `lastCooked` on a recipe, and may rewrite `week.json`.
Recipe content is edited in the files. Changes made to the files show up within a few seconds.

Access is through Home Assistant ingress only; the app opens no port.
