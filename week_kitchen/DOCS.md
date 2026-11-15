# Week Kitchen

A weekly meal planner that lives in the Home Assistant sidebar. Recipes, the week plan and
the page's settings are plain JSON files in `data_dir`, so anything that can write a file
(you, a script, an assistant with access to the folder) can add or edit recipes.

## Setup

1. **Settings → System → Storage → Add network storage**: usage *Share*, name `recipes`.
   It appears at `/share/recipes`. A *Media* mount works too, at `/media/<name>`; set `data_dir` to match.
2. Install and start the app, then open **Kitchen** in the sidebar.
   Every Home Assistant user sees it, admin or not. If someone still doesn't, it may be hidden in their sidebar: long-press the HA title to edit the sidebar.

## Data folder

```
data_dir/
  settings.json          optional: { "title", "accent", "tagline", "kid", "scoop" }
  week.json              written by the planner
  shop.json              the shared shopping list (picks and checkmarks) for the planned week
  timers.json            running kitchen timers
  recipes/<id>.json      one recipe per file; <id> is lowercase letters, digits, - and _
```

A recipe: `name`, `short`, `serves`, `time`, `gear`, `ing[]`, `steps[]` (`h` title, `x` HTML
text, `heat` H/MH/M/ML/L/OFF/O350/O400/O425, `hint` (optional line under the heat gauge, for this step only), `t` timer seconds, `kid` true for the "scoop a
portion" step), plus optional `kid` (note), `warn`, `leftovers`, `art`, `loved`, `lastCooked`.

The page may only change `loved` and `lastCooked` on a recipe, and may rewrite `week.json`.
Recipe content is edited in the files. Changes made to the files show up within a few seconds.

Two people can use it at once. The shopping list is shared and every tap is applied on its own,
so ticks from two phones both land. A week-plan save that was built on an older plan (the other
phone saved, or `week.json` was edited) is refused, and the page reloads the latest plan.

## Options

| Option | Default | |
|---|---|---|
| `data_dir` | `/share/recipes` | Where the files live |
| `timer_notify` | `[]` | Push a notification when a timer finishes. Each entry is a notify service (`mobile_app_my_phone`), sent for every timer, or `who=service`, sent only for timers that person started. `who` is matched against the Home Assistant user's id, login name or display name. Pushes are time-sensitive, so they ring through Focus and a locked screen, and are cleared when the timer is dismissed. |
| `tonight_sensor` | `true` | Keep `sensor.week_kitchen_tonight` set to tonight's planned dinner (attributes: `recipe`, `short`, `time`, `week`). |

Timers live on the server: they survive a reload, show on every open device, and ring there.
Cook mode keeps the screen awake while it is open.

Access is through Home Assistant ingress only; the app opens no port.
