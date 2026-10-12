---
type: decision
---

# UI and documentation conventions

## Context

Duplex had application-local UI atoms alongside Volt UI, and its documentation was a collection of
Markdown pages without a generated knowledge model. The call experience also used an opaque `/r/:roomId`
route even though the landing page and call page are separate experiences.

## Decision

Use Volt UI atoms for shared web controls and cards, keep application behavior in feature components and
services, and make `/` the landing route with `/call/:roomId` as the canonical call route. Adopt Entwine
as the documentation compiler and agent knowledge boundary for this repository.

## Why

Volt UI gives the application one component vocabulary and keeps accessibility behavior in the library.
Entwine keeps Markdown as the source of truth while providing generated docs, relationships and bounded
context for agents. The readable call route makes the product boundary visible in URLs.

## Consequences

The repository carries Entwine configuration, skills and a read-only MCP server. CI validates and builds
the documentation. The legacy `/r/:roomId` route remains as compatibility coverage for links already shared.
Agent instructions and skills are discoverable by Entwine but are not published to the public docs site.

## Alternatives

Keeping local duplicate atoms would split the UI contract. Linking to an external docs site without
adopting Entwine would not provide repository context or validation. Removing `/r/:roomId` immediately
would break existing room links.
