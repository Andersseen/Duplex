---
type: spec
---

# Call routing

## Purpose

Separate public product information from the live call experience while keeping room links anonymous and
shareable.

## Behavior

- `/` renders the landing page and creates a fresh opaque room id only after the user selects **Start a call**.
- `/call/:roomId` is the canonical call route. The page validates the room id before requesting microphone
  or camera access.
- `/r/:roomId` remains a compatibility route for previously shared links and uses the same call page implementation.
- A valid room link is a bearer capability. A room admits at most two participants while its Durable Object
  is addressed; there is no persistent room record.
- Invalid room ids show an error and offer a link back to the landing page without opening media.

## Related

- [Architecture](../architecture.md#web-delivery)
- [Security](../security.md)
- [Current state](../state.md)
