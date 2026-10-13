### Fixed

- **A model name that is not a plain Lua word no longer breaks the inbox.** Names such as `my-agent` are written as bracket keys, so the slot file still loads. A missing reply list or restore bundle is written empty instead of failing the file.
