# Avatar Voxel

Um avatar 3D que ouve, pensa e responde falando — rodando inteiro na sua máquina,
sem mandar nada para a nuvem e sem API paga.

```
microfone → Faster Whisper → Ollama → voz do Windows → lipsync do avatar
```

Os motores de nuvem (OpenAI Realtime e Gemini Live) são opcionais e ficam desligados
por padrão.

---

## Antes de instalar: de que você precisa?

Cada modo precisa de coisas diferentes. **Instale só o do seu modo.**

| | Ollama local | Gemini Live | GPT-Live |
|---|---|---|---|
| Node.js | sim | sim | sim |
| Python + `.venv` | **sim** | não | não |
| Ollama | **sim** | não | não |
| Chave de API | não | sim | sim |
| Custo | zero | pago | pago |

Nenhum dos três precisa de **ffmpeg** instalado: o Faster Whisper lê o áudio com PyAV,
que já traz as bibliotecas do FFmpeg dentro do pacote.

Se você vai usar Gemini ou GPT-Live, pule direto para os passos 1, 4 e 5.

---

## Instalação

### 1. Node.js — todos os modos

Precisa do [Node 18+](https://nodejs.org). O `start.bat` roda o `npm install` sozinho
na primeira vez (a única dependência é o `ws`).

### 2. Python do Faster Whisper — só no modo Ollama

Na pasta do projeto:

```bat
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

O servidor acha o `.venv` da pasta automaticamente — não precisa configurar nada.

**Com GPU NVIDIA** (bem mais rápido), instale os extras no lugar do comando acima:

```bat
.venv\Scripts\pip install -r requirements-gpu.txt
```

São ~1 GB a mais. Não precisa do CUDA Toolkit nem mexer no PATH: o worker encontra as
DLLs dentro do próprio venv. Se faltar alguma coisa, ele cai para CPU sozinho em vez de
quebrar no meio da conversa.

| | `small` em áudio de 3s |
|---|---|
| GPU (GTX 1060, int8) | ~0,4s |
| CPU (i7-8750H, int8) | ~2,5s |

### 3. Ollama — só no modo Ollama

Instale o [Ollama](https://ollama.com) e baixe um modelo:

```bat
ollama pull qwen3:4b-instruct-2507-q4_K_M
```

O app tem botão para subir e derrubar o Ollama.

### 4. Configuração — todos os modos

```bat
copy .env.example .env
```

No modo Ollama você não precisa preencher nada. Nos modos de nuvem, só a chave do motor
que for usar — e ela fica **só no servidor**, o navegador nunca a recebe.

### 5. Rodar — todos os modos

```bat
start.bat
```

Abre em <http://127.0.0.1:8787>.

---

## Como usar a voz

1. Deixe o motor em **Ollama** (o padrão).
2. **Conectar voz** — carrega o Whisper e começa a escutar. Ele detecta quando você
   parou de falar e responde sozinho.
3. **Mic** — escuta uma frase só e desconecta.

O microfone pausa enquanto o avatar fala, para não escutar a própria voz.

---

## Segurança

- O servidor escuta **só em `127.0.0.1`** e recusa requisições cujo `Host` ou `Origin`
  não sejam locais — sem isso, um site aberto no navegador conseguiria usar o proxy do
  Gemini e gastar a sua chave.
- `.env`, `.git/`, `data/` e `node_modules/` não são servidos pela web.
- As chaves de API nunca vão para o navegador: os endpoints só respondem
  `hasKey: true/false`.

---

## O que não vem no repositório

Nada disso é preciso para rodar — tudo está no `.gitignore`:

- `blender/` — o workspace que gerou o avatar. O modelo pronto já vai em
  `assets/voxel_avatar.glb`. Os renders do Blender carregam o caminho absoluto da
  máquina de origem nos metadados do PNG.
- `tools/TtsTool.exe` — o `start.bat` compila com o csc que já vem no Windows.
- `tmp/`, `node_modules/`, `.venv/`, `.env`, `data/ollama.json`.

---

## Estrutura

```
server.js              servidor local: estáticos + API + proxy do Gemini
index.html  css/  js/  interface e avatar (Three.js, sem build)
js/stt.js              captura do microfone, VAD e envio para o Whisper
tools/whisper_worker.py worker do Faster Whisper (JSONL no stdin/stdout)
tools/TtsTool.cs       voz do Windows (SAPI) + visemas para o lipsync
assets/                avatar 3D e as imagens dos visemas
```

## Créditos

As imagens dos visemas foram geradas com o xAI Grok Imagine e mantêm as Content
Credentials (C2PA) originais, que marcam a origem por IA.
