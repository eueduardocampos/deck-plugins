<#
.SYNOPSIS
  Instala o monitor de maquina do stream-deck-plugins no Stream Deck (Windows).

.DESCRIPTION
  1. confere que o app do Stream Deck esta instalado (pasta de plugins existe);
  2. copia lib/ para o bin/ do plugin (node scripts/sync-lib.js);
  3. liga o .sdPlugin na pasta de plugins do Stream Deck por JUNCTION (nao precisa de admin)
     ou, com -Copy, por copia;
  4. gera o perfil de varias paginas (.streamDeckProfile), sem importar;
  5. diz o que falta fazer a mao: reiniciar o app e importar o perfil.

  Nao fecha nem reinicia o Stream Deck, nao baixa nada, nao escreve em ProfilesV3 e nao
  sobrescreve um plugin que ja exista apontando para outro lugar.

.PARAMETER Plugins
  Quais plugins instalar. Padrao: sysmonitor (o unico deste repositorio).

.PARAMETER Copy
  Copia a pasta em vez de criar junction (use se a junction falhar; edicoes no repo nao refletem).

.PARAMETER SkipProfile
  Nao gera o perfil.

.PARAMETER Variant
  maquina (padrao) ou pessoal (maquina mais a pagina do plugin de IA; so faz sentido com o
  ai-usage instalado).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [ValidateSet('sysmonitor')] [string[]] $Plugins = @('sysmonitor'),
  [switch] $Copy,
  [switch] $SkipProfile,
  [ValidateSet('maquina', 'pessoal')] [string] $Variant = 'maquina'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sdPlugins = Join-Path $env:APPDATA 'Elgato\StreamDeck\Plugins'

function Say([string]$m) { Write-Host $m }

# --- 1. Stream Deck ----------------------------------------------------------
if (-not (Test-Path -LiteralPath $sdPlugins)) {
  throw "Pasta de plugins do Stream Deck nao encontrada: $sdPlugins. Instale o app do Stream Deck e abra-o uma vez."
}
Say "Stream Deck: $sdPlugins"

# --- 2. lib -> bin -----------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  if ($PSCmdlet.ShouldProcess("$root\lib", 'sincronizar lib/ nos plugins')) {
    & node (Join-Path $PSScriptRoot 'sync-lib.js') | ForEach-Object { Say "  $_" }
  }
} else {
  Write-Warning 'Node.js nao encontrado: nao consegui sincronizar lib/. O repositorio ja traz bin/render.js e bin/ws.js commitados; siga em frente.'
}

# --- 3. instalar cada plugin -------------------------------------------------
$instalados = @()
foreach ($p in $Plugins) {
  $src = Join-Path $root "plugins\$p\digital.astronauta.$p.sdPlugin"
  $dst = Join-Path $sdPlugins "digital.astronauta.$p.sdPlugin"
  if (-not (Test-Path -LiteralPath (Join-Path $src 'manifest.json'))) {
    throw "Plugin '$p' sem manifest.json em $src (o repositorio esta completo?)."
  }

  if (Test-Path -LiteralPath $dst) {
    $item = Get-Item -LiteralPath $dst -Force
    $alvo = @($item.Target) | Where-Object { $_ }
    if ($item.LinkType -eq 'Junction' -and ($alvo | Where-Object { $_.TrimEnd('\') -ieq $src.TrimEnd('\') })) {
      Say "  ${p}: ja instalado (junction para este repositorio)"
      $instalados += $p
      continue
    }
    Write-Warning "${p}: ja existe em $dst e nao aponta para este repositorio. Nao sobrescrevi. Remova ou renomeie essa pasta e rode de novo."
    continue
  }

  if ($Copy) {
    if ($PSCmdlet.ShouldProcess($dst, "copiar $p")) { Copy-Item -LiteralPath $src -Destination $dst -Recurse }
  } else {
    if ($PSCmdlet.ShouldProcess($dst, "criar junction para $src")) {
      New-Item -ItemType Junction -Path $dst -Target $src | Out-Null
    }
  }
  $marca = if ($WhatIfPreference) { "(simulado) " } else { "" }
  Say "  ${marca}${p}: instalado em $dst"
  $instalados += $p
}

# --- 4. perfil ---------------------------------------------------------------
$perfil = $null
if (-not $SkipProfile) {
  $py = Get-Command python -ErrorAction SilentlyContinue
  if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }
  if ($py) {
    if ($PSCmdlet.ShouldProcess('profiles/build_profile.py', "gerar perfil ($Variant)")) {
      & $py.Source -I (Join-Path $root 'profiles\build_profile.py') --variant $Variant | ForEach-Object { Say "  $_" }
    }
  } else {
    Write-Warning 'Python nao encontrado: perfil nao gerado. O .streamDeckProfile de maquina ja vem commitado em profiles/.'
  }
}

# --- 5. o que falta ----------------------------------------------------------
Say ''
Say 'Falta fazer a mao:'
Say '  1. Feche o Stream Deck pela bandeja do Windows (Quit) e abra de novo, para ele carregar os plugins.'
Say '  2. De dois cliques no arquivo .streamDeckProfile da pasta profiles\ para importar o perfil.'
Say '  Temperatura da CPU (opcional): LibreHardwareMonitor com o Remote Web Server ligado, porta 8085.'
