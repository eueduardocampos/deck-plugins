# Instalação

Funciona no **Windows 10/11** com **Stream Deck +** (8 teclas e 4 dials) e o app do Stream Deck 6.5
ou mais novo. O plugin é Node puro, sem `npm install`.

## Com dois cliques

1. Na [página de releases](https://github.com/eueduardocampos/stream-deck-plugins/releases/latest),
   baixe os dois arquivos: `digital.astronauta.sysmonitor.streamDeckPlugin` e
   `Astronauta - Maquina.streamDeckProfile`.
2. Dê dois cliques no `.streamDeckPlugin`. O app do Stream Deck abre e instala o plugin.
3. Dê dois cliques no `.streamDeckProfile` para importar as 3 páginas.
4. Troque de página com o *swipe* no touch strip.

Não precisa de Terminal, de Node nem de administrador. Para atualizar, baixe o `.streamDeckPlugin`
da release nova e dê dois cliques de novo.

## Pelo código

Para quem quer mexer no plugin. As edições no repositório aparecem no Stream Deck sem reinstalar.

```powershell
git clone https://github.com/eueduardocampos/stream-deck-plugins
cd stream-deck-plugins
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
```

O script liga o plugin ao app do Stream Deck por *junction* (sem administrador), gera o perfil e
diz o que falta. Use `-WhatIf` para só ver o que ele faria e `-Copy` para copiar em vez de ligar.

Depois:

1. Feche o Stream Deck pela bandeja do Windows (**Quit**) e abra de novo.
2. Dê dois cliques em `profiles\Astronauta - Maquina.streamDeckProfile`.
3. Troque de página com o *swipe* no touch strip.

Não instale das duas formas ao mesmo tempo: o script avisa se já existe um plugin instalado em outro
lugar e não sobrescreve.

## O que precisa

| Plugin | Precisa de | Opcional |
| --- | --- | --- |
| `sysmonitor` | nada além do Windows. Placa NVIDIA: o `nvidia-smi` que vem com o driver. Placa AMD ou Intel: nada, o uso e a memória vêm do próprio Windows. | [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) com o *Remote Web Server* ligado (porta 8085), para a temperatura da CPU e, em placa AMD ou Intel, para temperatura, energia, ventoinha e clock da GPU. Sem ele, essas teclas mostram `n/d`. |

Se você usava a v1.0.0: o plugin de RGB saiu deste repositório. Se ele foi instalado por junction, as
páginas de RGB do perfil antigo "Máquina e RGB" deixam de funcionar quando você atualiza. Importe o
perfil novo, que traz só as páginas de máquina, e apague o antigo no app do Stream Deck.

## Para um agente de IA instalar

Se você é um agente (Claude Code ou outro) instalando para o usuário, siga esta ordem e confirme
cada passo antes do seguinte:

1. **Confira o ambiente** (somente leitura): Windows, existência de
   `%APPDATA%\Elgato\StreamDeck\Plugins` (o app foi aberto ao menos uma vez), `node --version`
   (opcional) e `python --version` (para o perfil).
2. **Clone o repositório** num caminho que o usuário escolha e que não seja sincronizado
   (OneDrive/Drive atrapalham junctions e arquivos em uso).
3. **Simule**: `scripts\install.ps1 -WhatIf` e mostre ao usuário o que seria criado.
4. **Instale**: rode sem `-WhatIf`. O script **não sobrescreve** plugin existente que aponte para
   outro lugar; se avisar disso, pare e pergunte.
5. **Peça ao usuário** para reiniciar o Stream Deck pela bandeja e importar o perfil. Não encerre o
   processo do app à força: ele costuma rodar com permissões maiores que as suas.
6. **Verifique**: `node test\fake_sd_sysmonitor.js` (não toca no hardware) e, para o monitor, `node plugins\sysmonitor\digital.astronauta.sysmonitor.sdPlugin\bin\sources.js --probe`.
7. Não baixe nem instale o LibreHardwareMonitor sem o usuário autorizar o download.

## Problemas comuns

| Sintoma | Causa provável |
| --- | --- |
| Teclas aparecem como ação ausente | O app do Stream Deck não foi reiniciado depois da instalação. |
| `n/d` na temperatura da CPU | LibreHardwareMonitor fechado ou sem o *Remote Web Server*. |
| `ja existe ... nao aponta para este repositorio` | Há outra instalação do mesmo plugin; renomeie a pasta antiga e rode de novo. |
| A junction falha | Use `-Copy`. |
