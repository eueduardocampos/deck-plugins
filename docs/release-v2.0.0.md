## Stream Deck Plugins v2.0.0

Em épocas de inteligência artificial, fazer o melhor uso do seu hardware nunca foi tão necessário.
Esse plugin te ajuda nisso.

O repositório agora tem um plugin só: o **Monitor de máquina** (`digital.astronauta.sysmonitor`).
Processador, memória, placa de vídeo, disco e rede à vista no Stream Deck +, com 14 teclas e 5 dials.

### O que mudou

- **Saiu o plugin de RGB do gabinete** (`digital.astronauta.rgb`), junto com o `rgb-server`, os testes
  dele e o perfil "Máquina e RGB".
- O perfil do repositório passa a ser `profiles/Astronauta - Maquina.streamDeckProfile`, com 3 páginas:
  visão geral, GPU, e discos e rede.
- O instalador instala só o monitor, e a variante padrão do gerador de perfil é `maquina`.
- O Monitor de máquina continua igual, na versão 2.0.0.

### Quem usava a v1.0.0

Importe o perfil novo e apague o "Máquina e RGB" no app do Stream Deck. Se o RGB foi instalado por
junction, as páginas de RGB do perfil antigo deixam de funcionar quando você atualiza o repositório.

### Instalar

```powershell
git clone https://github.com/eueduardocampos/stream-deck-plugins
cd stream-deck-plugins
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
```
