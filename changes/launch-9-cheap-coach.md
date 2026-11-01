### Changed

- **Fight reviews run on the cheap model.** A `/ai review` now runs on the agent's cheap model by default, `haiku` for Claude, whatever model the chat picked, so one note per pull costs about nothing. Chats keep their own model. Set `agents.<id>.coachModel` in `bridge/config.json` to run reviews on another model; an agent with no cheap model, and one whose `models` list leaves it out, keep their normal model with no error.
