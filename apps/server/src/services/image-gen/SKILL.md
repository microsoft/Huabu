# Image Generation

Use this Service when the user asks you to generate an image through their configured Azure OpenAI image deployment.

`entry.mjs` is an executable starting point for basic prompt-to-image generation, not a complete provider SDK. Run `node entry.mjs --prompt "<prompt>" --quality <low|medium|high|auto> --output <path>`, or use `--prompt-file <path>` for a file-backed prompt. It obtains current configuration through the Agentlet Service SDK; never print, persist, or forward the supplied credentials.

When the task needs image editing or another provider feature that the entry does not implement, read the [Azure OpenAI image generation documentation](https://learn.microsoft.com/azure/ai-services/openai/how-to/dall-e), modify the local Package copy, and keep configuration retrieval through `AGENTLET_SERVICE_SDK_URL`.

The entry writes the generated image to the requested local path. Upload it through the existing Huabu RFS artifact workflow only when the user's task requires durable Space content.
