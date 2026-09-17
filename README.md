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

## Criar o seu próprio avatar

Cada pasta dentro de `assets/avatars/` é um avatar. Crie uma pasta, jogue os arquivos
dentro e **reinicie o servidor** — ele aparece no seletor, acima do palco. Não precisa
mexer em código.

O formato é deduzido do conteúdo da pasta:

| O que você põe na pasta | O que ganha |
|---|---|
| `visemes/` com as fotos | aba **2D · Imagem** |
| um arquivo `.glb` | aba **3D · Blender** |
| os dois | as duas abas |

As abas que o avatar não suporta ficam desabilitadas, e trocar para um avatar só-3D
muda de aba sozinho.

### Avatar 2D (fotos)

```
assets/avatars/meu-avatar/
  visemes/
    rest.jpg     ← único obrigatório: o rosto parado
    mbp.jpg      ← boca fechada (m, b, p)
    s.jpg        ← dentes (s, z, t)
    e.jpg        ← boca em "ê"
    aa.jpg       ← boca aberta
    aa_max.jpg   ← boca bem aberta
    o.jpg        ← boca em "ô"
    u.jpg        ← bico (u, w)
    blink.jpg    ← olhos fechados (opcional)
```

Valem `.jpg`, `.jpeg`, `.png` e `.webp`. **Só o `rest` é obrigatório** — os que faltarem
são substituídos pelo `rest` na hora de falar, então dá para começar com dois ou três e
ir completando. Use o mesmo enquadramento e resolução em todas, senão a troca "pula".

O ideal é que todas as fotos sejam do mesmo rosto, na mesma posição, mudando só a boca.
As do avatar base foram geradas por IA a partir de uma imagem só.

### Avatar 3D (Blender)

Exporte o `.glb` com shape keys chamadas `aa`, `ah`, `o`, `u`, `e`, `mbp`, `s` e `blk`,
e salve como `model.glb` na pasta. Qualquer `.glb` serve — se houver mais de um, ele
prefere o `model.glb`.

Se o seu modelo usa outros nomes de shape key, não precisa reexportar: reescreva o mapa
no `avatar.json` (campo `morphs`, abaixo).

### `avatar.json` — opcional

Sem ele o avatar funciona, usando o nome da pasta e os valores do avatar base. Serve
para ajustar:

```json
{
  "name": "Meu Avatar",
  "description": "Aparece embaixo do seletor",
  "order": 10,

  "eyes": [
    { "x": 0.385, "y": 0.445, "rx": 0.09, "ry": 0.07 },
    { "x": 0.615, "y": 0.445, "rx": 0.09, "ry": 0.07 }
  ],
  "glow": { "inner": "210,255,80", "outer": "80,220,40", "radius": 0.055 },
  "jaw": { "top": 0.54, "bottom": 0.63, "left": 0.18, "width": 0.64, "height": 0.32 },

  "morphs": { "rest": {}, "aa": { "jawOpen": 1 }, "o": { "mouthO": 1 } }
}
```

- **`eyes`** — onde ficam os olhos, em fração da imagem (`0.5` = meio). É daqui que sai
  o brilho e a máscara do piscar. **Se o seu rosto tem os olhos em outra altura, ajuste
  isto** — é o campo que mais importa num avatar novo.
- **`glow`** — cor do brilho dos olhos, em `R,G,B`.
- **`jaw`** — a faixa da imagem onde a boca é misturada, também em fração.
- **`morphs`** — só para 3D: de visema para shape key do seu modelo.

Uma pasta quebrada não derruba as outras: ela é ignorada e o servidor avisa no terminal.

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
  `assets/avatars/base/model.glb`. Os renders do Blender carregam o caminho absoluto da
  máquina de origem nos metadados do PNG.
- `tools/TtsTool.exe` — o `start.bat` compila com o csc que já vem no Windows.
- `tmp/`, `node_modules/`, `.venv/`, `.env`, `data/ollama.json`.

---

## Estrutura

```
server.js               servidor local: estáticos + API + proxy do Gemini
index.html  css/  js/   interface e avatar (Three.js, sem build)
js/avatar.js            avatar 2D: mistura as fotos dos visemas no canvas
js/avatar3d.js          avatar 3D: carrega o .glb e move as shape keys
js/stt.js               captura do microfone, VAD e envio para o Whisper
tools/whisper_worker.py worker do Faster Whisper (JSONL no stdin/stdout)
tools/TtsTool.cs        voz do Windows (SAPI) + visemas para o lipsync
assets/avatars/         um avatar por pasta; base/ é o que vem junto
```

## Créditos

As imagens dos visemas foram geradas com o xAI Grok Imagine e mantêm as Content
Credentials (C2PA) originais, que marcam a origem por IA.
