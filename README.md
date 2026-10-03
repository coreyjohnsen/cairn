# Cairn

A quiet, mountain-themed desktop app for chatting with any AI model, putting it to work on your files, and making pictures. Runs on Windows and Linux, uses NVIDIA (CUDA) and AMD (ROCm or Vulkan) GPUs, and works with local models, local servers and cloud APIs side by side.

## What it does

**Chat with any model.** Add as many connections as you like and pick between them from the chat box:

- This computer: Cairn downloads and manages llama.cpp for your GPU and runs GGUF models directly.
- Any OpenAI-compatible server: Ollama, LM Studio, llama.cpp, KoboldCpp, vLLM, OpenRouter, OpenAI, Groq, Together and so on. "Look for running servers" finds local ones for you.
- Anthropic (native API).

Models you download can be renamed with the pencil on Models, then Local models, and a download whose file is just called `model.gguf` is named after its Hugging Face repository. Reasoning models have a Thinking switch (Auto, On, Off) beside the Tools button; it applies to models running in Cairn, Ollama and other servers on your network, and OpenRouter, and other connections ignore it. With Off, Cairn starts its own llama.cpp with reasoning disabled and also sends the template switches that other servers understand; if a model still reasons, the reply says so, because some models and servers cannot switch it off. Settings, then Chat, sets the default.

**Agent tools.** With tools switched on, a model can read, search, create, edit, move and delete files inside a working folder you choose, run shell commands, fetch web pages, search the web, and generate images. Anything that changes files or runs commands asks first (Allow once, Allow for this chat, Always allow, Decline), and file edits show a diff before you approve. You can also add:

- Custom tools: small JavaScript functions with a JSON schema and a built-in test runner. They run in a sandboxed worker with a timeout.
- MCP servers: stdio, SSE or streamable HTTP. Their tools appear next to the built-in ones and obey the same permissions.

Two limits are yours to set under Settings, Chat: "Steps per request" (how many tool calls one request may chain) and "Tool output limit" (the longest tool result sent to the model, in characters). Each takes any number, and 0 means no limit; the output limit starts at 0. With a limit, `read_file` returns only whole lines that fit and ends with "call read_file again with offset=N to continue", so paging never repeats or skips; with no limit it returns the whole file. Command output and fetched pages follow the same setting. The model's own memory counts too: a tool result is also held to about 40% of what is left of the model's context after the system prompt and tool list, so on a small Context size (the 8,192 default under Models, Local models) a file comes back in smaller pieces with the offset to continue from. For agent and file-editing work, 16,384 or more is much better.

**Long tasks and the model's memory.** A big job (read a dozen files, edit, run tests, repeat) fills a small context quickly. Instead of dropping the oldest steps, Cairn summarizes them: when the model's memory is about 75% full, everything except the most recent steps is replaced, for the model only, by a summary made of three parts: what you asked (in your words), a list of every tool call so far (files read, files created or changed, commands with their exit codes, searches, anything you declined), and the model's own short account of the goal, what is done, what it learned about each file and what comes next. The list is built from the messages themselves, so it stays exact even if a small model writes a thin account; if the model cannot write one at all, the list alone is kept. Your chat still shows every message, with a line marking where the summary takes over ("Summarized for the model", click to read it). The pill at the top of a chat shows how full the memory is (the server's real token count, once it has reported one); click it to summarize right now, read the summary, or go back to sending the whole chat. If a server ever says a request did not fit, Cairn summarizes harder and asks again instead of ending the task. Settings, Chat has a switch and the percentage. It only works where the memory size is known (models run by Cairn, and servers that report it) and needs room for the chat of at least about 2,500 tokens after the system prompt and tool list; with less, the oldest messages are trimmed as before. Summaries cost one extra model call each, so a larger context is still the best fix: on a 16 GB card, Models, Local models, Runtime, "Memory precision" at 8-bit (with flash attention on) stores the model's working memory in half the space, so 32,768 tokens fit where 16,384 did.

**Image generation.**

- In chat: type `/imagine a misty alpine lake at dawn`, press the picture button, or just ask in plain words. A tool-capable model can also call `generate_image` itself.
- Image Hub: everything you have made, with search, favourites, a full-screen viewer, reuse-settings, image-to-image and inpainting, and a create panel (model, shape and size, steps, CFG, sampler, seed, batch of 1, 2, 4 or 8). The right side has two views, switched at the top: **Focus** shows the picture being made (a progress card while it is drawn, then the picture itself) or the one you picked large, with its settings and actions underneath and the earlier pictures in a History list beside it (arrow keys step through, Enter opens full screen, and the list moves under the picture in a narrow window); **Grid** shows them all at once. In the create panel, Size, Avoid, LoRAs, Upscale and Advanced fold to a single line that says what is set, and "Start from" switches between Text and Edit a picture. Each job shows which part it is in (load the model, read the prompt, draw, decode, save) with a running clock, so the long decode at the end no longer looks frozen. Size can be set with Small, Default, Large and Huge buttons relative to the model's own size, or as exact width and height, and Cairn warns when a size is likely to give poor results for that type of model (for example Stable Diffusion 1.x far above 512, SDXL at 512, extreme shapes, or sizes that need more video memory than is likely free). FLUX, SD3 and Z-Image sizes are rounded to a multiple of 16.
- LoRAs (built-in engine) and upscaling (Real-ESRGAN, any Vulkan GPU): see "Using LoRAs" and "Upscaling" below. Presets, saved defaults and prompt aliases: see "Presets, defaults and aliases".
- Backends: the built-in engine (stable-diffusion.cpp, downloaded for your GPU), ComfyUI, AUTOMATIC1111 / Forge, and OpenAI-style image APIs. Supports SD 1.x/2.x, SDXL, Flux, SD3 and Z-Image Turbo weights, including GGUF.

**Share your models with other programs.** Models, then Serve, turns the chat and image models on this computer into an OpenAI-compatible service, so editors, scripts, other apps and other devices can use them. See "Sharing your models" below.

**Chat formatting.** Replies render Markdown, code with highlighting and copy buttons, tables, and maths (`$x^2$`, `$$ … $$`, `\( … \)` and `\[ … \]`, typeset with KaTeX; dollar amounts such as "$5" are left as text).

**Design.** Four mountain palettes (Alpenglow dusk, Glacier light, Granite, Timberline) plus "match system", drawn ridgeline art, no clutter. Text size, reduced motion and backdrop toggles are in Settings.

## Quick start (developers)

You need **Node 22.12 or newer** (Node 22 LTS or 24 LTS both work). Older versions, including Node 18 and 20, will not work: Electron 44 and the build tools require it, and `npm install` stops with a message if yours is too old. Check with `node -v`. On Windows, `winget install OpenJS.NodeJS.LTS` installs the current LTS; open a new terminal afterwards.

```
npm install
npm run dev
```

The dev window opens with hot reload. To look at the interface in a normal browser with scripted demo data and no Electron or backend:

```
npm run dev:web
```

then open http://localhost:5173 (options: `?theme=glacier`, `?view=images`, `?platform=win32`, `?scenario=empty`).

Windows users: keep the project **outside OneDrive** (for example `C:\dev\cairn`). `node_modules` contains tens of thousands of small files and OneDrive syncing will make installs and builds slow and flaky.

## Building the executables

```
npm install
npm run dist:win      # on Windows: NSIS installer + portable .exe  ->  release/
npm run dist:linux    # on Linux:   AppImage, .deb, .tar.gz         ->  release/
```

Build each platform on its own platform. Windows installers cannot be produced on Linux without Wine, and the repository's GitHub Actions workflow (`.github/workflows/build.yml`) does both for you: push a tag such as `v1.0.0` and it publishes the installers to a GitHub release.

Output files:

| Platform | File |
|---|---|
| Windows installer | `Cairn-<version>-win-x64.exe` |
| Windows portable (keeps data beside the exe) | `Cairn-<version>-portable.exe` |
| Linux | `Cairn-<version>-linux-x86_64.AppImage`, `Cairn-<version>-linux-amd64.deb`, `.tar.gz` |

The AppImage runs without installation: `chmod +x Cairn-*.AppImage && ./Cairn-*.AppImage`. It starts with Chromium's SUID sandbox disabled, because AppImages cannot ship the helper; the `.deb` keeps the normal sandbox.

The installers are not code-signed, so Windows SmartScreen will warn on first run ("More info", then "Run anyway"). Signing needs a certificate; electron-builder picks one up from the usual `CSC_LINK` / `CSC_KEY_PASSWORD` variables.

`npm run icons` regenerates `build/icon.*` from the vector mark in `scripts/make-icons.mjs`.

## GPUs

Open Models, then Engines and GPU. Cairn detects your GPU and recommends a backend:

- **NVIDIA (GTX and RTX):** CUDA builds. The newest CUDA runtime your driver supports is chosen automatically, and the matching runtime libraries are downloaded alongside. GTX 10-series and older are kept on CUDA 12.
- **AMD on Windows:** Vulkan is recommended and works well on RDNA 2 cards such as the RX 6900 XT. A HIP/ROCm build is offered when the upstream project publishes one for your engine.
- **AMD on Linux:** ROCm if it is installed, otherwise Vulkan through Mesa RADV. For RDNA 2 cards that ROCm does not officially list, set `HSA_OVERRIDE_GFX_VERSION=10.3.0` (Models, Engines and GPU has an Environment variables box for each engine).
- **No supported GPU:** CPU builds.

Engines are downloaded at runtime from the llama.cpp and stable-diffusion.cpp GitHub releases rather than bundled, so the installer stays small and you can update an engine without reinstalling the app.

## Using LoRAs

A LoRA is a small add-on file that nudges a model toward a style, a character or a subject. It does not replace the model: you pick a normal model as usual and add one or more LoRAs on top.

1. **Get one.** Models, then Image models, then "Find more". On Civitai set the type to LORA; on Hugging Face search for a LoRA repository. Cairn files it under `models/image/lora` for you. You can also drop `.safetensors` files into that folder yourself (the "Open LoRA folder" button opens it) and press Rescan.
2. **Match it to your model.** A LoRA only works with the family it was trained for: SD 1.x, SDXL, FLUX and SD 3 LoRAs are not interchangeable. Cairn reads this from the file when it can (shown as a badge) and warns in the create panel when the LoRA and the chosen model do not match. LoRAs work with the built-in engine only, not ComfyUI, AUTOMATIC1111 or API backends.
3. **Add it.** In the Image Hub create panel, choose a model, then "Add a LoRA…" under the shape controls. You can add several.
4. **Set the strength.** 0.6 to 1.0 is the usual range; start at 0.8. Lower is subtler, higher is stronger, and above about 1.2 pictures often start to break. Negative values push away from the style.
5. **Add trigger words if it needs them.** Many LoRAs only react to a particular word or phrase, which is on the LoRA's download page. Type it in the Trigger box (Cairn adds it to the start of your prompt) or click a suggestion read from the file. Models, Image models, then LoRAs and upscalers lets you save a usual strength and trigger for each LoRA so they are filled in next time.

Under the hood Cairn gives stable-diffusion.cpp the LoRA folder and puts `<lora:name:strength>` tags in the prompt; the picture's details in the viewer list the LoRAs it used and "Reuse settings" brings them back.

## Upscaling

Upscaling is done by Real-ESRGAN (the portable `realesrgan-ncnn-vulkan` program), which runs on any Vulkan graphics card: NVIDIA, AMD (the RX 6900 XT needs no ROCm for this) and Intel, on Windows and Linux. Models, Image models, then Upscalers has an "Install the upscaler" button (about 45 MB, from the Real-ESRGAN GitHub release). It comes with `realesrgan-x4plus`, which is the one to use for photographs and realistic or painted pictures, `realesrgan-x4plus-anime` for anime and cartoons, and the `realesr-animevideov3` models (2x, 3x and 4x, light and fast, for anime and illustrations). It also works on pictures made by ComfyUI, AUTOMATIC1111 and the image APIs, not only the built-in engine.

Why not the built-in engine's own upscaler? stable-diffusion.cpp documents support for one upscaler model, RealESRGAN_x4plus_anime_6B, which is trained on anime and makes photographs look smooth and waxy, and it silently saves the picture unchanged when it cannot load any other, such as 4x-UltraSharp. Cairn still lists those files, marked "Built-in engine" or "Untested", and still checks for the unchanged-picture case, but Real-ESRGAN is the recommended route. If the upscaler runs out of video memory on a big picture, Cairn retries once with small tiles on its own.

You can add more Real-ESRGAN models in the ncnn format: put the `.param` and `.bin` pair (same name) in the upscaler folder and they appear in the list.

Upscaler files go in `models/image/upscale` (Open upscaler folder). Two ways to use one: choose it under "Upscale when done" in the create panel to enlarge each new picture as it is made (Passes repeats the enlargement), or open any picture in the viewer and press Upscale to make a bigger copy of it. The copy is saved as a new picture and the original is kept.

## Presets, defaults and aliases

**LoRA presets.** Once LoRAs are chosen in the create panel, the bookmark button beside "Apply a preset" saves the whole combination (each LoRA's strength and trigger words) under a name; saving under an existing name replaces it. Choosing a preset sets the LoRAs in one click and tells you if a file in it is no longer in the LoRA folder. Presets can be renamed or deleted under Models, Image models, LoRAs and upscalers.

**Editing a picture (image to image and masks).** Press "Edit picture" on any picture, or choose "Edit a picture" under "Start from" and pick one by dropping a file on the panel, pasting (Ctrl+V), browsing or choosing from the pictures you already made. The picture fills the big view and becomes the canvas, and everything happens on it:

- **Paint the part to change** with the brush, eraser, rectangle or lasso (B, E, R, L; [ and ] change the brush size; scroll to zoom, hold Space to move; Ctrl+Z undoes). Leave it unpainted to redo the whole picture from this one.
- **Describe the change in the box under the picture** and press Generate (Ctrl+Enter works too). "Change inside the paint" sets how far the painted part may move away from the original, with about how many steps will run; "Paint options" holds Repaint (just that area, which is sharper and quicker because the engine works on a crop and the result is blended back, or the whole picture), Soft edge and Margin around it. Pixels you did not paint stay exactly as they were.
- **See the change in place.** The picture shows progress while it is made, then the result appears on the same canvas with a Before / After switch. Ask for 2 or 4 and flip between Result 1 to 4. Regenerate makes it again from the original picture and the same paint (new seed unless you set one); "Keep and continue" makes the result you are looking at the picture to edit next, with the paint cleared so you can mark another part. Picking a different picture in History while editing carries on from that one.
- Done goes back to the pictures. Switching to Text keeps your paint for when you come back.

With the shape on Auto, a whole-picture edit takes the starting picture's shape at the model's usual size, so it is not stretched; if you pick a different shape, Cairn warns that it will be. A painted-area edit always comes back the size of the original. Pictures you bring in are converted to PNG, scaled down to 2048 pixels on the longest side and kept in the gallery marked as imported. It works with the built-in engine (the installed stable-diffusion.cpp must support `--mask` for painted edits; Cairn says so if not) and AUTOMATIC1111; ComfyUI and OpenAI-style APIs say they cannot start from a picture or use a mask, and a mask cannot be combined with the built-in engine's own upscaler (Real-ESRGAN upscaling works). Reusing the settings of a picture that was made this way brings back its starting picture and strength, not the paint.

**Upscale by default.** Once `realesrgan-x4plus` is installed (see Upscaling), "Upscale when done" starts switched on with it in the Image Hub. Choose Off in the picker to skip it for one picture, or turn the default off with the switch under Models, Image models, Upscalers. It does not apply to `/imagine` in chat or to pictures a model asks for with `generate_image`, which stay as they were.

**Saved steps and guidance.** Under Advanced, "Save as default for this model" stores the current steps and guidance for the model that is selected (each model keeps its own, since a Turbo model and an ordinary one want very different numbers). They are used whenever that model is chosen, from the Image Hub, `/imagine` or a tool call, until a request sets its own; "Clear saved default" goes back to the model's built-in numbers.

**Prompt aliases.** The Aliases button above the prompt opens a list where a short word or phrase stands for a longer text, for example `moody` for "dramatic lighting, volumetric fog, muted colours, film grain". Type the alias in a prompt and it is replaced when the picture is made; the create panel shows "Sent as" under the prompt whenever something was replaced. Aliases match whole words or phrases and ignore capitals (`cabin` changes "a Cabin at dawn", not "cabins"), the longest name wins where two overlap, and an expansion is not searched for more aliases, so they cannot loop. They apply to the prompt and the "Avoid" text for every picture, including `/imagine` and tool calls, and the picture's record keeps the expanded text.

## Window and layout

Side panels can be resized: drag the thin line on the edge of the chat list, the Image Hub's create panel, its History list or the full-screen viewer's details (double-click the line to put it back, or focus it and use the arrow keys). Ctrl+B folds or shows the side panel of the current screen (the chat list or the create panel), and each has a button to do the same. Widths and which panels are folded are remembered on this computer. The chat column, the pages under Models, Tools and Settings, and the Image Hub's big picture all grow with the window, and the chat column grows further when the chat list is folded. On Windows, the minimise, maximise and close buttons are drawn over the top-right corner of the window; the mask editor's toolbar, dialogs and the welcome screen keep clear of them.

## Sharing your models

Models, then Serve, has one switch. When it is on, Cairn answers OpenAI-style requests on `http://127.0.0.1:8321/v1` (the port can be changed), starts again whenever Cairn starts, and stops when you quit. Anything that lets you set a base URL and a key works: the OpenAI libraries, editors, chat front ends, scripts.

What it serves:

- `GET /v1/models`: the models you share, with the name to use. Chat models are named after the file or the name you gave them (`Qwen3-8B-Q4_K_M`), with no spaces; the tab shows each name and copies it on click. The absolute file path also works.
- `POST /v1/chat/completions` and `POST /v1/completions`, with or without `stream`. They go to the llama.cpp engine Cairn manages, so tools, images in messages and JSON output work as far as that engine supports them. Leave `model` out to get the model used last.
- `POST /v1/images/generations`: `prompt`, `model`, `n` (up to 4), `size` ("768x512"), and `response_format` (`url`, the default, or `b64_json`). Extras: `negative_prompt`, `steps`, `cfg_scale`, `seed`, `sampler`. Only models that run in Cairn's own image engine are shared. Pictures are saved in the Image Hub like any other, and your prompt aliases and saved steps and guidance apply. A `url` is a link that signs itself and works for 24 hours without the key; it stops working when Cairn restarts.
- Not offered: embeddings, audio, image edits. They answer 501 with a message.

**One model at a time.** Only one chat model is loaded. Requests for the model that is loaded share it (llama.cpp queues them); a request for a different model waits until the answers in progress are done, then the model is swapped, in the order requests arrived. The same rule covers chat inside Cairn, and freeing video memory for a picture waits for answers in progress instead of cutting them off. A streamed request gets its response headers at once and a comment line every few seconds while a model loads, so clients do not time out; a non-streaming request simply waits. If the other program hangs up, the answer or picture stops.

**Who can connect.** "This computer only" listens on 127.0.0.1 and refuses any Host name other than localhost or an address, which stops a web page from reaching it under a made-up name. "Other devices on my network" listens on every interface, always requires the key, and shows the addresses to give out. The connection is plain HTTP, so use it only on a network you trust, and allow the port in the firewall if Windows or your distribution asks. The API key (`Authorization: Bearer ...` or `x-api-key`) is made when you first turn the server on, is stored encrypted like your other keys, and "New key" replaces it. On this computer alone you can turn the key requirement off.

**Web pages.** A browser sends an `Origin` header; requests from pages that are not on the list under "Web pages" are refused before anything runs, so a page you happen to visit cannot use your models. Add the address of your own web app (for example `https://my-app.example`) or `*`. Programs that are not browsers are not affected.

**Activity.** The tab lists recent requests (path, model, time, status, tokens, errors). Prompts and replies are not recorded anywhere.

Try it:

```
curl http://127.0.0.1:8321/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"model": "Qwen3-8B-Q4_K_M", "messages": [{"role": "user", "content": "Hello!"}]}'
```

In Windows PowerShell, `curl` is a different command that does not take those options, so use this instead (or `curl.exe` with the data in a file):

```
$body = @{ model = "Qwen3-8B-Q4_K_M"; messages = @(@{ role = "user"; content = "Hello!" }) } | ConvertTo-Json -Depth 5
$reply = Invoke-RestMethod -Uri "http://127.0.0.1:8321/v1/chat/completions" -Method Post -ContentType "application/json" -Headers @{ Authorization = "Bearer YOUR_KEY" } -Body $body
$reply.choices[0].message.content
```

The tab also shows ready-made curl, PowerShell and Python examples with your own address and model names.

## Getting models

- **Chat:** Models, then Local models. Search Hugging Face from inside the app, pick a GGUF quantisation, and download ("Open page" on a result opens its web page, for the model card and licence). Check the file size against your video memory first; GPU layers can be lowered if a model does not fit. Or connect a server that already has models.
- **Images:** Models, then Image models. Starter packs cover SDXL Turbo, SD Turbo, FLUX.1 schnell and Z-Image Turbo (a Q8 pack for 12 GB and up, a Q4 pack for 6 to 8 GB); you can also search Civitai or paste any direct link.

**A grey or blank image, or a failure at the very end:** the last step (decoding) needs the most video memory. Cairn now stops with a clear message when the engine reports running out of memory there, instead of saving a grey picture. Turn on "VAE tiling" for that model (Models, Image models, then the pencil) or choose a smaller size.

Tokens for Hugging Face and Civitai go in Settings, then Storage. Some files need one: FLUX's VAE (`ae.safetensors`) is gated, so accept the licence on its Hugging Face page and add a token. If Hugging Face returns a 403 or rate limit on a big file, a token usually fixes it, and any download can be resumed.

## Where things live

| | Windows | Linux |
|---|---|---|
| App data | `%APPDATA%\Cairn` | `~/.config/Cairn` |
| Models and engines | `<app data>\models`, `<app data>\engines` (changeable in Settings, Storage) | same |

Chats, settings and the image library are plain JSON and PNG files. API keys and tokens are encrypted with the operating system's keychain (Windows DPAPI, Linux libsecret/kwallet) when it is available. On a Linux machine with no keyring they are stored as plain text in the settings file, so keep that file private there. The portable Windows build and the `CAIRN_DATA_DIR` environment variable keep everything in a folder you choose.

## Safety model

File tools are confined to the chat's working folder; paths that escape it (including through symlinks and `..`) are refused. Reads and searches run automatically, writes, deletes and commands ask, and "Always allow" is deliberately not offered for deletes and commands. Every permission can be changed per tool under Tools. The renderer runs with context isolation, no Node integration, the Chromium sandbox and a strict Content-Security-Policy; remote images in model output are blocked.

## Project layout

```
src/main        Electron main process: providers, agent loop, tools, engines, image backends, API server (src/main/server), storage
src/preload     the typed bridge exposed as window.cairn
src/renderer    React interface (views, components, stores, hand-written CSS themes)
src/shared      types and IPC contracts shared by both sides
tests           Vitest suites for the main process (npm test)
scripts         icon generation
```

`npm run typecheck` checks both halves, `npm test` runs the suites.

## What has and has not been verified

Verified in development: type checking and 503 unit tests pass; the production build and a Linux AppImage and .deb build and launch; in the real Electron app, streaming chat, a tool call with an approval prompt and diff, the resulting file on disk, `/imagine`, and Image Hub generation against stand-in OpenAI-style and AUTOMATIC1111 servers.

Not exercised on real hardware or networks, so expect to report rough edges (stand-alone upscaling of an existing picture uses `sd-cli -M upscale`, and multiple passes use `--upscale-repeats`; I could not check either against a real engine build, and Cairn tells you if your build does not support them; whether a given llama.cpp build honours the reasoning-off switch; the first stages of an image job, loading and reading the prompt, are recognised from log lines I could not confirm against a real engine, so those two may show as one until sampling starts; the sampling and decoding stages use log lines taken from a real engine log): the API server against a real llama.cpp and image engine and from other devices or client programs (the tests use stand-ins), downloading engines and models from GitHub and Hugging Face, running llama.cpp and stable-diffusion.cpp on an actual GPU (CUDA, ROCm, Vulkan), ComfyUI and Anthropic live calls, the Windows installer, and the starter-pack download URLs (they are plain links you can edit in `src/shared/defaults.ts`).
