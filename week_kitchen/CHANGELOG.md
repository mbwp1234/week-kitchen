## 0.2.1
- Read the Supervisor token from s6's container environment too, so timer pushes and the tonight sensor switch on.

## 0.2.0
- Phone-first: tonight's recipe leads, the week is a swipeable strip, tabs fit one row; cook mode puts the timer and heat above the fold.
- "We made this" on every recipe (undoable), so suggestions and "Made N days ago" stay true without finishing cook mode.
- The shopping list is shared between devices; each tap is applied on its own so two shoppers never overwrite each other. "Uncheck all" asks for a second tap.
- Timers are held by the server: they survive reloads, show on every device, and can push a time-sensitive notification (`timer_notify`).
- A week-plan save built on an outdated plan is refused and the page reloads the latest, instead of silently overwriting the other phone's change.
- Cook mode keeps the screen awake by itself.
- Shopping list: red bell pepper is produce (was filed under pantry); full-fat and plain oat milk merge; plural counts read as plurals.
- New `sensor.week_kitchen_tonight` (`tonight_sensor`).

## 0.1.1
- Map `/media` as well as `/share`, so a network-storage mount added with usage *Media* works (`data_dir: /media/<name>`).

## 0.1.0
- First release: recipe box, week planner, shopping list and cook mode served over ingress, stored as JSON files in `data_dir`.
