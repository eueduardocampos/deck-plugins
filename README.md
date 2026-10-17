# Stream Deck Plugins

Em épocas de inteligência artificial, fazer o melhor uso do seu hardware nunca foi tão necessário.
Esse plugin te ajuda nisso.

O **Monitor de máquina** é um plugin de **Elgato Stream Deck +** que deixa à vista o que o seu PC
está fazendo: processador, memória, placa de vídeo, disco e rede. Rodou um modelo local e a memória
de vídeo encheu? A tecla fica amarela, depois vermelha. Não precisa abrir o Gerenciador de Tarefas
pra descobrir.

Mesmo sistema visual do plugin de IA ([`ai-usage`](https://github.com/eueduardocampos/ai-usage)).
Cada página tem 8 teclas e 4 dials.

| Plugin | UUID | O que mostra |
| --- | --- | --- |
| Monitor de máquina | `digital.astronauta.sysmonitor` | CPU, RAM, GPU (uso, temperatura, VRAM, energia, ventoinha, clock), espaço e velocidade de disco, rede. Coleta sozinho, sem administrador. |

O perfil `profiles/Astronauta - Maquina.streamDeckProfile` traz 3 páginas: visão geral, GPU, e
discos e rede. A troca de página é por swipe no touch strip.

> Projeto pessoal, sem relação com a Elgato ou a NVIDIA. Até 17/10/2026 o repositório se chamava
> `deck-plugins` e também tinha um plugin de RGB do gabinete, que saiu na v2.0.0.

## Estrutura

```
lib/               renderizador (render.js) e WebSocket (ws.js) canônicos
plugins/           o .sdPlugin do monitor
profiles/          gerador do perfil (.streamDeckProfile)
scripts/           instalador e sync-lib.js
test/              Stream Deck falso
docs/00-convencoes.md   contrato: ações, settings, páginas
```

## Instalação

Veja o [INSTALL.md](INSTALL.md): um script instala o plugin sem administrador, e há um roteiro para
um agente de IA instalar para você.

## Como usar

```bash
node scripts/sync-lib.js                 # copia lib/ para o plugin
python profiles/build_profile.py         # gera o perfil
node test/fake_sd_sysmonitor.js          # testes (sem hardware)
```

## Temperatura da CPU

O Windows não expõe a temperatura da CPU sem um driver de kernel. A tecla `cputemp` lê o
[LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) (servidor web
na porta 8085, ligado nas opções dele); sem ele, mostra `n/d`.
