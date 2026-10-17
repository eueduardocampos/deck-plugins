## Stream Deck Plugins v2.2.0

O Monitor de máquina passa a ler placa de vídeo AMD e Intel, não só NVIDIA.

### O que mudou

- **Placa AMD ou Intel:** o uso e a memória de vídeo vêm do próprio Windows, os mesmos números do
  Gerenciador de Tarefas. Não precisa instalar nada.
- **Temperatura, energia, ventoinha e clock** de placa AMD ou Intel vêm do LibreHardwareMonitor, como
  a temperatura do processador. Sem ele, essas teclas mostram `n/d` e dizem `sem LHM`.
- **Placa integrada** (a que vem no processador): a tecla de VRAM mostra a memória compartilhada.
- **PC com Radeon e Intel integrada:** vale a Radeon.
- Placa NVIDIA continua igual, pelo `nvidia-smi`.
- Sem placa de vídeo que o plugin reconheça, as teclas de GPU dizem `sem GPU`.

Plugin na versão 2.1.0. Testado com dados simulados de Radeon, Intel integrada e NVIDIA; ainda não
foi conferido num PC com placa AMD ou Intel.

### Instalar

1. Baixe os dois arquivos abaixo.
2. Dois cliques no `.streamDeckPlugin`.
3. Dois cliques no `.streamDeckProfile`.
