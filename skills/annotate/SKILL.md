---
name: annotate
description: Use when the user wants to give visual feedback on a running web app by clicking elements in a browser (Annotate toolbar) and have you apply the changes.
---

# Annotate loop

1. `open(url)` — the user's dev server (e.g. http://localhost:3000). A visible browser opens with the toolbar.
2. `wait_for_feedback()` — blocks until the user clicks **Send to AI**.
   - `{"status":"waiting"}` means timeout: just call it again. Nothing is lost, and the queue persists.
   - Otherwise you get `annotations: [{id, comment, url, selector, source?, text?, screenshot?}]`.
3. For each annotation:
   - `source` (`file:line`) present → open that file directly.
   - No `source` → search the project for `text` and the class names in `selector`.
   - Need more context? `get_annotation_details(id, ["styles"])`, or `["html"]`, or `["screenshot"]`.
     Ask only for what you need. Screenshots are the most expensive item.
4. Edit the code. Hot reload updates the browser.
5. `resolve_annotation(ids)`. If it returns `errors`, fix them before continuing.
6. Go back to step 2.

## Rules
- Handle the whole batch, then resolve it together with one call.
- Verify cheaply. The `errors` in the resolve result are usually enough. Request a screenshot only when appearance is the thing being checked.
- If `open` returns `human_has_control`, wait. The user is driving the browser.
- Unfinished work is listed in `.annotate/ANNOTATIONS.md`. In a fresh session, call `wait_for_feedback` first and it returns those items immediately.
