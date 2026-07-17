# Microsoft Responsible AI Transparency Documentation for Research - Huabu

## Overview

Huabu is a canvas-based interaction framework for human–AI collaboration. It provides a shared two-dimensional workspace where humans and AI agents co-work on the same materials — documents, web pages, notes, and AI conversations — arranged as persistent, spatially organized nodes.

Huabu is designed around three principles: externalizing thinking, so that the intermediate structure of work becomes visible and manipulable; sharing a cognitive space with AI, so that agents can follow broader intent rather than only the latest instruction; and supporting natural interaction — handwriting, touch, and speech alongside typing — so that users can stay in flow while ideas are still forming.

### WHAT CAN Huabu do

Huabu was developed to support the early, exploratory stages of complex work — where the central challenge is deciding what to do, rather than executing well-formed instruction. On the canvas, users can externalize ideas, notes, references, and AI outputs as persistent nodes; arrange them spatially to reflect relationships, priorities, and uncertainty; and let AI agents observe the evolving workspace to help organize materials, synthesize across nodes, identify what remains unresolved, and hand off mature ideas to downstream execution agents.

<!-- A detailed discussion of Huabu, including how it was developed and tested, can be found in our paper at: [PAPER LINK TO BE ADDED] -->

### INTENDED USES

Huabu is best suited for open-ended, exploratory knowledge work — including research, planning, ideation, and early-stage design — where intent is still forming and benefits from being externalized and discussed in a shared visual space rather than a linear chat thread.

Huabu is being shared with the research community to facilitate reproduction of our results and foster further research in this area.

Huabu is intended to be used by domain experts who are independently capable of evaluating the quality of outputs before acting on them.

### OUT-OF-SCOPE USES

Huabu is not well suited for tasks that require a single authoritative answer, time-critical decision making, or workflows where the AI’s outputs would be acted on without human review. It is also not suited for users who lack the domain expertise needed to evaluate AI-generated content on the canvas, since responsibility for assessing quality and correctness rests with the user.

We do not recommend using Huabu in commercial or real-world applications without further testing and development. It is being released for research purposes.

Huabu was not designed or evaluated for all possible downstream purposes. Developers should consider its inherent limitations as they select use cases, and evaluate and mitigate for accuracy, safety, and fairness concerns specific to each intended downstream use.

Without further testing and development, Huabu should not be used in sensitive domains where inaccurate outputs could suggest actions that lead to injury or negatively impact an individual's legal, financial, or life opportunities.

We do not recommend using Huabu in the context of high-risk decision making (e.g. in law enforcement, legal, finance, or healthcare).

## HOW TO GET STARTED

To begin using Huabu, download the latest installer for your operating system from the [GitHub Releases page](https://github.com/microsoft/Huabu/releases), then run the installer and launch the application. See the repository README for instructions on connecting a base LLM/MLLM and configuring example workflows.

## Evaluation

Huabu was evaluated on its ability to support exploratory knowledge work scenarios — including research synthesis, planning, and ideation — through internal dogfooding and qualitative studies with researchers.

<!-- A detailed discussion of our evaluation methods and results can be found in our paper at: [PAPER LINK TO BE ADDED] -->

### EVALUATION METHODS

We used qualitative observation, task walk-throughs, and structured user feedback from internal dogfooding sessions to measure Huabu’s performance.

We compared the performance of Huabu against the linear chat baseline that is the dominant paradigm today using participant-reported feedback across research, planning, and ideation scenarios.

The model used for evaluation was GPT 5.5. For more on this specific model, please see [Introducing GPT-5.5 | OpenAI](https://openai.com/index/introducing-gpt-5-5/).

Results may vary if Huabu is used with a different model based on its unique design, configuration and training.

### EVALUATION RESULTS

At a high level, we found that Huabu performed well in helping users externalize and organize early-stage thinking, reduced the cognitive load of holding intermediate ideas in working memory, and made it easier for AI agents to act on the broader context of a task rather than only the latest message.

## LIMITATIONS

Huabu was developed for research and experimental purposes. Further testing and validation are needed before considering its application in commercial or real-world scenarios. It does not control any downstream agents, and users are responsible for configuring them safely.

Huabu was designed and tested using the English language. Performance in other languages may vary and should be assessed by someone who is both an expert in the expected outputs and a native speaker of that language.

Outputs generated by AI may include factual errors, fabrication, or speculation. Users are responsible for assessing the accuracy of generated content. All decisions leveraging outputs of the system should be made with human oversight and not be based solely on system outputs.

Huabu inherits any biases, errors, or omissions produced by the model you choose to use with it. Developers are advised to choose an appropriate MLLM carefully, depending on the intended use case.

There has not been a systematic effort to ensure that systems using Huabu are protected from security vulnerabilities such as indirect prompt injection attacks. Any systems using it should take proactive measures to harden their systems as appropriate.

## BEST PRACTICES

Better performance can be achieved by curating canvas content carefully, keeping nodes concise and well-labeled, and grouping related materials spatially so that the AI agent can interpret structure from the layout. Reviewing AI suggestions before acting on them — particularly before handing canvas content off to downstream execution agents — is strongly recommended.

We strongly encourage users to use LLMs/MLLMs that support robust Responsible AI mitigations, such as Azure Open AI (AOAI) services. Such services continually update their safety and RAI mitigations with the latest industry standards for responsible use. For more on AOAI’s best practices when employing foundations models for scripts and applications:

- [What is Azure AI Content Safety?](https://learn.microsoft.com/en-us/azure/ai-services/content-safety/overview)
- [Overview of Responsible AI practices for Azure OpenAI models](https://learn.microsoft.com/en-us/legal/cognitive-services/openai/overview)
- [Azure OpenAI Transparency Note](https://learn.microsoft.com/en-us/legal/cognitive-services/openai/transparency-note)
- [OpenAI’s Usage policies](https://openai.com/policies/usage-policies)
- [Azure OpenAI’s Code of Conduct](https://learn.microsoft.com/en-us/legal/cognitive-services/openai/code-of-conduct)

Users are responsible for sourcing their datasets legally and ethically. This could include securing appropriate rights, ensuring consent for use of audio/images, and/or the anonymization of data prior to use in research.

Users are reminded to be mindful of data privacy concerns and are encouraged to review the privacy policies associated with any models and data storage solutions interfacing with Huabu.

It is the user’s responsibility to ensure that the use of Huabu complies with relevant data protection regulations and organizational guidelines.

Developers should follow transparency best practices and inform end-users they are interacting with an AI system.

## LICENSE

MIT License

Nothing disclosed here, including the Out of Scope Uses section, should be interpreted as or deemed a restriction or modification to the license the code is released under.

## TRADEMARKS

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft trademarks or logos is subject to and must follow Microsoft’s Trademark & Brand Guidelines. Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship. Any use of third-party trademarks or logos are subject to those third-party's policies.

## CONTACT

This research was conducted by members of [Microsoft Research](https://www.microsoft.com/en-us/research/). We welcome feedback and collaboration from our audience. If you have suggestions, questions, or observe unexpected/offensive behavior in our technology, please contact us at huabu@microsoft.com.

If the team receives reports of undesired behavior or identifies issues independently, we will update this repository with appropriate mitigations.
