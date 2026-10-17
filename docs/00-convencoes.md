# Convenções e contrato dos plugins (stream-deck-plugins)

Este arquivo é o **contrato** do repositório: tudo que o plugin e o gerador de perfil precisam
combinar entre si. Quem muda um nome de ação ou um endpoint muda aqui primeiro.

## Objetivo

Um plugin de Stream Deck **separado** do plugin de IA (`digital.astronauta.claudeusage`, repo
`eueduardocampos/ai-usage`), reaproveitando o **mesmo sistema visual** dele, e um perfil de várias
páginas. Até 17/10/2026 o repositório também tinha o RGB do gabinete (`digital.astronauta.rgb`),
que mudou para o repositório privado `eueduardocampos/rgb-gabinete`.

| Plugin | UUID | Papel |
| --- | --- | --- |
| Monitor de máquina | `digital.astronauta.sysmonitor` | CPU, RAM, GPU, VRAM, discos (espaço e velocidade), rede. **Coleta sozinho.** |

**Regra do Eduardo: cada página tem sempre 8 teclas + 4 dials** (Stream Deck +).

## Estrutura

```
stream-deck-plugins/
  lib/                      renderizador e WebSocket CANÔNICOS (copiados para cada plugin)
  plugins/
    sysmonitor/digital.astronauta.sysmonitor.sdPlugin/
  profiles/                 gerador do perfil .streamDeckProfile
  scripts/sync-lib.js       copia lib/ para bin/ de cada plugin
  test/                     harness de Stream Deck falso (um por plugin)
  docs/
```

`node scripts/sync-lib.js` copia `lib/render.js` e `lib/ws.js` para o `bin/` de cada `.sdPlugin`
(o Stream Deck instala cada plugin como pasta isolada, então não dá para referenciar arquivo de
fora). **Nunca edite `bin/render.js` ou `bin/ws.js` direto**: edite em `lib/` e sincronize.

## Regras herdadas (docs do workspace do Eduardo)

- UUID `digital.astronauta.<nome>`; ações `<uuid>.<acao>`.
- **Zero dependências npm.** Node 20 embutido no app. WebSocket é o `ws.js` escrito à mão.
- Funciona em Windows 11 (alvo) sem admin.
- **Sem dado, a tecla diz o motivo** (`OFF`, `n/d`, `reconectar`...). Nunca fica em branco e nunca
  mostra um número inventado.
- Cor pelo nível (`safe`/`warn`/`danger`/`critical`/`offline`) com **limiar por métrica**: CPU a 90%
  é normal num build, disco a 90% é problema.
- Perfis **gerados por script** e entregues como `.streamDeckProfile` (duplo clique). Nunca escrever
  direto em `ProfilesV3`.

## Sistema visual (copiar do plugin de IA 4.2.1)

Referência: `ai-usage/streamdeck/digital.astronauta.claudeusage.sdPlugin/bin/{plugin,render,unified}.js`.

- Tecla: SVG 144×144 por `R.clean(view)`; dial: 200×100 por `R.clean(view, true)` num layout
  `layouts/clean.json` (um `pixmap` chamado `canvas`). `view = {label, value, sub, level, accent, pct}`.
- Título curto em caixa alta, número grande, detalhe pequeno, barra fina só quando há percentual.
- Fundo `#10151c`, texto `#f0f6fc`, detalhe `#acb8c8`, trilho `#303a47`.
- Cor de destaque (`accent`) por família: CPU `#5aa9ff`, RAM `#b48cff`, GPU `#76b900`, disco `#ffb454`,
  rede `#4dd0e1`. `level` vermelho/amarelo sobrepõe o accent.
- Pressionar uma tecla de monitor abre o Gerenciador de Tarefas (`taskmgr`); girar o dial alterna a
  métrica; tocar no strip força atualização; pressionar o dial executa a ação principal do grupo.

## Catálogo de ações (CONTRATO com o gerador de perfil)

### sysmonitor — `digital.astronauta.sysmonitor.<acao>`

Teclas (`Controllers: ["Keypad"]`):

| Ação | Mostra | Settings da instância |
| --- | --- | --- |
| `cpu` | uso total % | |
| `cputemp` | temperatura da CPU (via LibreHardwareMonitor; sem ele: `n/d`) | |
| `ram` | uso % + GB usados/total | |
| `gpu` | uso % | |
| `gputemp` | temperatura °C | |
| `vram` | VRAM usada / total | |
| `gpupower` | energia W (e % do limite) | |
| `gpufan` | ventoinha % | |
| `gpuclock` | clock MHz (e % do máximo) | |
| `disk` | espaço usado % + GB livres de uma unidade | `{ "drive": "C" }` (padrão `C`) |
| `diskwrite` | velocidade de **gravação** em disco (MB/s) | `{ "disk": "total" }` |
| `diskread` | velocidade de leitura em disco (MB/s) | `{ "disk": "total" }` |
| `netdown` | download (Mb/s ou MB/s) | |
| `netup` | upload | |

Dials (`Controllers: ["Encoder"]`, `Encoder.layout = "layouts/clean.json"`): cada um gira entre itens.

| Ação | Gira entre |
| --- | --- |
| `dialcpu` | uso total, frequência, temperatura (se houver), threads |
| `dialmem` | uso %, GB usados, GB livres |
| `dialgpu` | uso, temperatura, VRAM, energia, ventoinha, clock |
| `dialdisk` | espaço de cada unidade que responde (C, D, E…) e velocidade de gravação/leitura |
| `dialnet` | download, upload, total da sessão |

Global settings: `{ refreshCpuSeconds:1, refreshGpuSeconds:3, refreshDiskSeconds:60, refreshIoSeconds:2,
lhmUrl:"http://127.0.0.1:8085", drives:["C","D","E"] }`.

**Cuidado:** `G:` e `I:` neste PC são montagens do Google Drive e reportam números idênticos e sem
sentido. Nunca varrer unidades automaticamente numa tecla; a letra é setting.

Detalhes fixados na implementação (v2.0.0):

- Settings de instância: `disk` aceita `"C"` ou `"C:"`; sem `drive` o padrão é `C`.
  `diskwrite`/`diskread` aceitam `disk: "total"` ou uma letra; sem `disk` o padrão é `total`.
  Dials guardam o item atual em `cycleIndex` (inteiro).
- Disco (gravação/leitura), rede e a frequência da CPU vêm de **um coletor PowerShell persistente**
  (`Win32_PerfFormattedData_*`, independente do idioma, `-EncodedCommand`, sem admin). O coletor só
  liga enquanto há tecla que o use, desliga 30 s depois de perder o último uso e morre junto com o plugin.
- Rede em bits (kb/s, Mb/s, Gb/s, base 1000); disco em bytes (KB/s, MB/s, GB/s, base 1024). Só soma
  interfaces reais (filtra loopback, vEthernet, VMware, VPN, WSL, Tailscale por nome).
- Níveis: `gpupower`, `gpuclock`, gravação, leitura e rede são informativos (`safe`). Limiares
  aviso/crítico: cpu e ram 80/95, gpu e vram 85/95, gputemp 75/85, cputemp 80/90, disk 85/95, gpufan 80/95.
- Dado mais velho que 4× o intervalo da fonte vira `n/d`; a tecla nunca finge estar viva.
- Temperatura da CPU: LibreHardwareMonitor em `lhmUrl`; sem ele, `n/d` e o `dialcpu` omite o item.
- GPU AMD e Intel (sem `nvidia-smi`): uso e memória pelo coletor PowerShell (`GPUPerformanceCounters`,
  os mesmos do Gerenciador de Tarefas); nome e VRAM total pelo registro; temperatura, energia,
  ventoinha e clock pelo LibreHardwareMonitor (sem ele, essas teclas dizem `sem LHM`). Placa
  integrada (menos de 1 GB de VRAM própria) mostra a memória compartilhada, com teto de metade da RAM.
- Limitações: só a primeira GPU NVIDIA; com AMD e Intel juntas, vale a de mais VRAM (o contador do
  Windows não diz o nome da placa, então o uso vem da que mais usa memória dedicada); CPU % vem de `os.cpus()` (o Gerenciador de Tarefas usa
  "Processor Utility", pode diferir alguns pontos); o filtro de interfaces de rede é heurístico.

## Perfil

Gerado por `profiles/build_profile.py` (mesmo método do `build_profile.py` do ai-usage). Um perfil,
várias páginas, uma por assunto; no Stream Deck + a troca de página é por swipe no touch strip.

| Página | Teclas (8) | Dials (4) |
| --- | --- | --- |
| Máquina · Visão geral | cpu, ram, gpu, vram, gputemp, disk(C), diskwrite, netdown | dialcpu, dialmem, dialgpu, dialdisk |
| Máquina · GPU | gpu, gputemp, vram, gpupower, gpufan, gpuclock, cpu, ram | dialgpu, dialcpu, dialmem, dialnet |
| Máquina · Discos e rede | disk(C), disk(D), disk(E), diskwrite, diskread, netdown, netup, cputemp | dialdisk, dialnet, dialcpu, dialmem |
| IA · Consumo *(só variante pessoal)* | claude5, claude7, codexquota, source, claudeburn, codexburn, clauderoi, codexroi | aiwindows, aiburn, aicosts, aitotals |

Variantes do gerador (`profiles/build_profile.py --variant ...`): `maquina` (padrão: as 3 páginas de máquina; é o que vai no repo) e `pessoal` (máquina mais IA; sai em `profiles/pessoal/`, fora do git). No modelo do Stream Deck a página padrão fica fora da lista `Pages`. `--into <perfil.sdProfile>` acrescenta as páginas que faltam a um perfil já importado, com o app fechado e backup antes.

## Testes

Cada plugin traz um `test/fake_sd_<plugin>.js` no estilo de `test/fake_sd.js`: sobe um Stream Deck
falso (protocolo real) e uma fonte falsa, spawna o `plugin.js` de verdade, manda `willAppear` para
**todas** as ações do manifest, gira os dials e confere `setImage`/`setFeedback`. `exit 0` = passou.
Testes **não tocam no hardware** (nem drivers).
