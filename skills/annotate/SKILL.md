---
name: annotate
description: Use when the user wants to give visual feedback on a running web app by clicking elements in a browser (Annotate toolbar) and have you apply the changes.
---

# Annotate loop

1. `open(url)` — the user's dev server (e.g. http://localhost:3000). A visible browser opens with the toolbar.
2. `wait_for_feedback()` — blocks until the user clicks **Send to AI**.
   - `{"status":"waiting"}` means timeout: just call it again. Nothing is lost, and the queue persists.
   - Otherwise you get `annotations: [{id, comment, url, selector, source?, element_text?, screenshot?}]`.
3. For each annotation:
   - `source` (`file:line`) present → open that file directly.
   - No `source` → search the project for `element_text` and the class names in `selector`.
   - Need more context? `get_annotation_details(id, ["styles"])`, or `["html"]`, or `["screenshot"]`.
     Ask only for what you need. Screenshots are the most expensive item.
4. Edit the code. Hot reload updates the browser.
5. `resolve_annotation(ids)`. It reloads the page, then **waits for the next round** and returns it the same way as `wait_for_feedback`.
   If it returns `errors`, fix them first. Go back to step 3.

## Rules
- **Never end your turn while the user is annotating.** Feedback cannot be pushed to you; it only arrives while you are blocked in `wait_for_feedback` or `resolve_annotation`. On `{"status":"waiting"}`, call `wait_for_feedback` again. Stop only if the user says they are done.
- **The comment is about the selected element.** "this", "the name", "the text" and "the color" all refer to the element in `selector`/`element_text`, not to similar things elsewhere on the page. Change only that element, unless the comment explicitly says "everywhere" or "all".
- If a comment is truly ambiguous even with the element, make the narrowest change and say what you assumed in the `note`.
- Handle the whole batch, then resolve it together with one call.
- Verify cheaply. The `errors` in the resolve result are usually enough. Request a screenshot only when appearance is the thing being checked.
- If `open` returns `human_has_control`, wait. The user is driving the browser.
- Unfinished work is listed in `.annotate/ANNOTATIONS.md`. In a fresh session, call `wait_for_feedback` first and it returns those items immediately.
