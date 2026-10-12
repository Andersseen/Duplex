---
name: volt-ui
description: Use Volt UI atoms and conventions in this Angular application.
---

# Volt UI

This workspace uses the package mode of `@voltui/components`.

## Rules

- Import components from `@voltui/components`, never from the library's internal `volt` alias.
- Use standalone components, `OnPush`, signals, and explicit imports.
- Prefer native elements with the `voltButton` directive for buttons and links:
  `<button voltButton>` and `<a voltButton routerLink="/">`.
- Use `volt-card`, `volt-badge`, `volt-input`, `volt-textarea`, `volt-checkbox`, and
  `volt-progress` for their respective UI atoms instead of recreating their chrome in app code.
- Keep product layouts, state, icons, motion, and domain components in the app. Do not create a
  second button, card, badge, or form-control wrapper under `src/app/ui`.
- Use semantic Volt tokens such as `bg-background`, `bg-card`, `bg-muted`, `text-foreground`,
  `text-muted-foreground`, `border-border`, `text-destructive`, `text-success`, and
  `text-warning` instead of app-specific token aliases.
- Overlays use an attribute trigger and an `ng-template`; do not invent `<volt-dialog>` or
  `<volt-tooltip>` trigger elements.
- Do not invent component inputs. Check the package declarations or the Volt MCP server when unsure.

## References

- MCP: `https://volt-ui.pages.dev/api/mcp`
- Documentation: `https://volt-ui.andersseen.dev/docs/ai-mcp`
