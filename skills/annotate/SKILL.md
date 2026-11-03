---
name: annotate
description: Use when the user wants to give visual feedback on a running web app or desktop app by clicking elements, drawing on the screen, or snapshotting an app window (Annotate), and have you apply the changes.
---

# Annotate

The user clicks elements in their running site, writes comments, and presses **Send to AI**. You apply the comments to the code.

## Start
`open(url)`: the user's dev server, e.g. `http://localhost:4321`. A browser window opens with the toolbar.
- If the result says `next: ...end your turn...` (push mode), tell the user it's ready and **end your turn**. Each batch they send arrives later as a new message, usually in a new session.
- Otherwise, call `wait_for_feedback()`.

## Each batch
1. `wait_for_feedback()` returns `annotations: [{id, comment, url, selector, source?, element_text?, css?, screenshot?}]`.
   On `{"status":"waiting"}` (a timeout), just call it again. Nothing is lost.
2. Find the code:
   - `source` (`file:line`) → open that file at that line.
   - `css` (`file:line selector`) → for style changes, edit that rule directly. Don't read the whole stylesheet.
   - Neither → search for `element_text` and the class names in `selector`.
   - Still unsure? `get_annotation_details(id, ["styles"])` (or `"html"`, `"screenshot"`). Ask only for what you need; screenshots cost the most.
   - `kind: "draw"`: the user circled an area instead of clicking. The comment is about that area; `source`/`css`
     describe the main element under the drawing (they may be missing over empty space). The image with the drawing is
     attached. `get_annotation_details(id, ["under"])` lists a few more elements under it.
3. Edit the code. Handle the whole batch before resolving.
4. `resolve_annotation(ids, note)` with all the ids and a one-line note on what you changed. It reloads the page.
   If it returns `errors`, fix them.
   - Push mode: it returns `next: ...end your turn`. Do that.
   - Otherwise it waits and returns the next batch. Go back to step 2.

## Tell the user where things stand
- After `open`: **✅ Annotate ready. Click elements, comment, then Send to AI.**
- After each batch, list what you changed (one line each), then end with exactly:
  **✅ Annotate done. Waiting for your next annotation.**

## Rules
- **The comment is about the selected element.** "this", "the name", "the text" and "the color" all mean the element in `selector`/`element_text`, not similar things elsewhere. Change only that element, unless the comment says "everywhere" or "all".
- If a comment is still ambiguous, make the narrowest change and state your assumption in `note`.
- Not in push mode: **never end your turn while the user is annotating.** Feedback only reaches you while you're waiting in `wait_for_feedback` / `resolve_annotation`. Stop only when the user says they're done.
- If `open` returns `human_has_control`, wait. The user is using the browser.
- Verify cheaply: the `errors` from `resolve_annotation` are usually enough. Take a screenshot only when appearance is the question.
