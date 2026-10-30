# 62: Tools: REST shape to function shape

**What to build:** The body's tools become model function tools with their parameter schema passed through. A tool that cannot be represented refuses the cascade rather than disappearing.

**Blocked by:** 57 (Stored-body field map)

**Status:** resolved

- [ ] REST tools become function tools with the parameters schema passed through.
- [ ] A name that violates the vendor rule refuses the cascade by name; a tool is never dropped silently.
- [ ] The adapter supplies a missing root type rather than relying on the vendor to add it.
- [ ] A test round-trips one body tool through the built request.

## Answer

62 tools conversion: done, green — 497 tests (+5 in `cascade/test_body_map.py`) on Python 3.14 venv; branch `cluster/body-58-25`, base `83ea36ed`, commit `8e91223a`.
Shape (extends 57): REST `{name,description,parameters,...}` → `{"type":"function","function":{name,description,parameters}}`; a missing root `type` is supplied as `"object"` by the adapter, an existing schema is passed through untouched, and a tool with no schema gets no invented one.
Never dropped: an unrepresentable tool (bad name — 61's rule, or non-object `parameters`) refuses the whole set by path (`tools[1].name`, `tools[0].parameters`); there is no partial config, so a bad second tool cannot silently disappear.
Round-trip: one body tool is adapted and sent through `build_chat_request`; the payload's `tools` equals the expected function object exactly and `tool_choice` is `"auto"`.
No vendor repair relied on: the request scanned in the test already carries the root `type`, because the adapter added it.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
