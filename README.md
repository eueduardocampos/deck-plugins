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
| Monitor de máquina | `digital.astronauta.sysmonitor` | CPU, RAM, GPU NVIDIA, AMD ou Intel (uso, temperatura, VRAM, energia, ventoinha, clock), espaço e velocidade de disco, rede. Coleta sozinho, sem administrador. |

O perfil `profiles/Astronauta - Maquina.streamDeckProfile` traz 3 páginas: visão geral, GPU, e
discos e rede. A troca de página é por swipe no touch strip.

> Projeto pessoal, sem relação com a Elgato, a NVIDIA, a AMD ou a Intel. Até 17/10/2026 o repositório se chamava
> `deck-plugins` e também tinha um plugin de RGB do gabinete, que saiu na v2.0.0.

## Estrutura

```
lib/               renderizador (render.js) e WebSocket (ws.js) canônicos
plugins/           o .sdPlugin do monitor
profiles/          gerador do perfil (.streamDeckProfile)
scripts/           instalador pelo código e sync-lib.js
test/              Stream Deck falso
docs/00-convencoes.md   contrato: ações, settings, páginas
```

## Instalação

Baixe o `digital.astronauta.sysmonitor.streamDeckPlugin` na
[página de releases](https://github.com/eueduardocampos/stream-deck-plugins/releases/latest) e dê
dois cliques. Depois, dois cliques no perfil `Astronauta - Maquina.streamDeckProfile`, que está na
mesma página.

Para instalar pelo código, e para o roteiro de um agente de IA instalar para você, veja o
[INSTALL.md](INSTALL.md).

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

## Placa de vídeo AMD ou Intel

Com placa NVIDIA, tudo vem do `nvidia-smi`, que já vem com o driver. Com placa AMD ou Intel, o uso
e a memória de vídeo vêm do próprio Windows, os mesmos números do Gerenciador de Tarefas.
Temperatura, energia, ventoinha e clock vêm do LibreHardwareMonitor; sem ele, essas teclas mostram
`n/d` e dizem `sem LHM`. Em placa integrada, a tecla de VRAM mostra a memória compartilhada.
