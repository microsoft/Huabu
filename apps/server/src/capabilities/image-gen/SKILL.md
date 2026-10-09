# Image Generation

Use this Capability when the user asks you to generate an image through their configured Azure OpenAI image deployment.

Load the Capability through the Agentlet SDK URL in `AGENTLET_CAPABILITY_SDK_URL`. Call the returned client's `generate()` method with a non-empty `prompt` and optional provider-supported image parameters. Provider credentials are supplied only to the loaded client; never print, persist, or include them in another request.

The client returns the provider response. Decode or upload generated image bytes through the existing Huabu RFS artifact workflow only when the user's task requires durable Space content.
