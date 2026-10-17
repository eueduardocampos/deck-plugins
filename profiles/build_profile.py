"""Gera os perfis do stream-deck-plugins (Stream Deck +, 8 teclas + 4 dials por página).

Dois perfis, por variante:
  --variant maquina   (padrão)  'Máquina': o monitor de máquina em 3 páginas.
                                É o que vai no repositório e serve para qualquer pessoa.
  --variant pessoal             'Máquina e IA': as páginas de máquina mais a do plugin de IA
                                (repo ai-usage). Sai em profiles/pessoal/, fora do git.

O RGB do gabinete mudou para o repositório privado rgb-gabinete em 17/10/2026.

Mesmo método do build_profile.py do ai-usage: o perfil é um .streamDeckProfile (zip) com um
manifest raiz e um manifest por página, importado por duplo clique. NUNCA escrever direto em
ProfilesV3: o app do Stream Deck mantém os perfis em memória e sobrescreve.

Cada ação é validada contra o manifest.json do plugin dono dela (existe? é Keypad/Encoder?)
e cada página precisa ter exatamente 8 teclas e 4 dials.

    python profiles/build_profile.py                      # perfil Máquina
    python profiles/build_profile.py --variant pessoal    # perfil com a IA
    python profiles/build_profile.py --check              # só valida, não grava
    python profiles/build_profile.py --variant pessoal --into "%APPDATA%/Elgato/StreamDeck/ProfilesV3/<id>.sdProfile"
        # acrescenta as páginas que faltam a um perfil JÁ IMPORTADO (Stream Deck fechado; faz backup)
"""
from __future__ import annotations

import json
import os
import sys
import uuid
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent

PLUGINS = {
    "digital.astronauta.sysmonitor": ROOT / "plugins" / "sysmonitor" / "digital.astronauta.sysmonitor.sdPlugin",
    # O plugin de IA vive no repo ai-usage; só entra na variante pessoal.
    # O caminho pode ser trocado pela variável AI_USAGE_PLUGIN.
    "digital.astronauta.claudeusage": Path(os.environ.get(
        "AI_USAGE_PLUGIN",
        ROOT.parent / "ai-usage" / "streamdeck" / "digital.astronauta.claudeusage.sdPlugin")),
}

DEVICE_MODEL = "20GBD9901"  # Stream Deck +

SM, AI = "digital.astronauta.sysmonitor", "digital.astronauta.claudeusage"


def a(ns, action, **settings):
    """(UUID completo da ação, settings da instância)."""
    return (f"{ns}.{action}", settings)


# --------------------------------------------------------------------------- páginas
# Cada página: 8 teclas (ordem de leitura: 4 colunas x 2 linhas) e 4 dials.
MAQ = [
    {
        "key": "maq-geral",
        "name": "Máquina · Visão geral",
        "keys": [a(SM, "cpu"), a(SM, "ram"), a(SM, "gpu"), a(SM, "vram"),
                 a(SM, "gputemp"), a(SM, "disk", drive="C"), a(SM, "diskwrite", disk="total"), a(SM, "netdown")],
        "dials": [a(SM, "dialcpu"), a(SM, "dialmem"), a(SM, "dialgpu"), a(SM, "dialdisk")],
    },
    {
        "key": "maq-gpu",
        "name": "Máquina · GPU",
        "keys": [a(SM, "gpu"), a(SM, "gputemp"), a(SM, "vram"), a(SM, "gpupower"),
                 a(SM, "gpufan"), a(SM, "gpuclock"), a(SM, "cpu"), a(SM, "ram")],
        "dials": [a(SM, "dialgpu"), a(SM, "dialcpu"), a(SM, "dialmem"), a(SM, "dialnet")],
    },
    {
        "key": "maq-discos",
        "name": "Máquina · Discos e rede",
        "keys": [a(SM, "disk", drive="C"), a(SM, "disk", drive="D"), a(SM, "disk", drive="E"),
                 a(SM, "diskwrite", disk="total"), a(SM, "diskread", disk="total"),
                 a(SM, "netdown"), a(SM, "netup"), a(SM, "cputemp")],
        "dials": [a(SM, "dialdisk"), a(SM, "dialnet"), a(SM, "dialcpu"), a(SM, "dialmem")],
    },
]

IA_CONSUMO = {
    "key": "ia-consumo",
    "name": "IA · Consumo",
    "keys": [a(AI, k) for k in ("claude5", "claude7", "codexquota", "source",
                               "claudeburn", "codexburn", "clauderoi", "codexroi")],
    "dials": [a(AI, k) for k in ("aiwindows", "aiburn", "aicosts", "aitotals")],
}

VARIANTS = {
    "maquina": {
        "name": "Astronauta - Máquina",
        "file": HERE / "Astronauta - Maquina.streamDeckProfile",
        "id": "3E8A5C91-7D42-4B16-A0F3-C95B1E7D2A68",  # fixo: reimportar substitui, não duplica
        "pages": MAQ,
    },
    "pessoal": {
        "name": "Astronauta - Máquina e IA",
        "file": HERE / "pessoal" / "Astronauta - Maquina e IA.streamDeckProfile",
        "id": "B2F7A0D4-91C3-4E68-8B15-7A9E3D6C0F42",
        "pages": MAQ + [IA_CONSUMO],
    },
}


# --------------------------------------------------------------------------- validação
def needed_plugins(pages):
    return {u.rsplit(".", 1)[0] for p in pages for u, _ in p["keys"] + p["dials"]}


def load_manifests(namespaces):
    out, problems = {}, []
    for ns in sorted(namespaces):
        folder = PLUGINS.get(ns)
        mf = folder / "manifest.json" if folder else None
        if mf is None or not mf.is_file():
            problems.append(f"manifest ausente para {ns}: {mf}")
            continue
        data = json.loads(mf.read_text(encoding="utf-8-sig"))
        out[ns] = {"manifest": data, "actions": {x["UUID"]: x for x in data.get("Actions", [])}}
    if problems:
        raise SystemExit("\n".join(problems))
    return out


def validate(variant, manifests):
    errors, warnings = [], []
    for page in variant["pages"]:
        if len(page["keys"]) != 8:
            errors.append(f"[{page['key']}] {len(page['keys'])} teclas (esperado 8)")
        if len(page["dials"]) != 4:
            errors.append(f"[{page['key']}] {len(page['dials'])} dials (esperado 4)")
        for kind, items in (("Keypad", page["keys"]), ("Encoder", page["dials"])):
            for uuid_, _settings in items:
                ns = uuid_.rsplit(".", 1)[0]
                act = manifests.get(ns, {}).get("actions", {}).get(uuid_)
                if act is None:
                    errors.append(f"[{page['key']}] ação inexistente no manifest: {uuid_}")
                    continue
                if kind not in act.get("Controllers", ["Keypad"]):
                    errors.append(f"[{page['key']}] {uuid_} não é {kind} (é {act.get('Controllers')})")
    return errors, warnings


# --------------------------------------------------------------------------- montagem
def entry(uuid_, settings, manifests, seed):
    ns = uuid_.rsplit(".", 1)[0]
    m = manifests[ns]
    act = m["actions"][uuid_]
    return {
        "ActionID": str(uuid.uuid5(uuid.NAMESPACE_URL, f"deck-plugins/{seed}")),
        "LinkedTitle": True,
        "Name": act["Name"],
        "Plugin": {"Name": m["manifest"]["Name"], "UUID": ns, "Version": m["manifest"]["Version"]},
        "Resources": None,
        "Settings": dict(settings),
        "State": 0,
        "States": [{"FTitle": "", "Title": ""}],
        "UUID": uuid_,
    }


def build_page(variant, page, manifests):
    controllers = []
    for kind, items in (("Keypad", page["keys"]), ("Encoder", page["dials"])):
        actions = {}
        for i, (uuid_, settings) in enumerate(items):
            pos = f"{i % 4},{i // 4}"
            seed = f"{variant['id']}/{page['key']}/{kind}/{pos}"
            actions[pos] = entry(uuid_, settings, manifests, seed)
        controllers.append({"Type": kind, "Actions": actions})
    return {"Controllers": controllers, "Icon": "", "Name": page["name"]}


def page_id(variant, page):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"deck-plugins/{variant['id']}/page/{page['key']}")).upper()


def sd_running():
    try:
        import subprocess
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq StreamDeck.exe", "/NH"],
                             capture_output=True, text=True).stdout
        return "StreamDeck.exe" in out
    except OSError:
        return False


def add_into(variant, profile_dir, manifests, force=False):
    """Acrescenta ao perfil instalado as paginas da variante que ainda nao existem.

    Reaproveita as paginas que ja estao la (reconhecidas pelo nome), preserva o ID do perfil,
    troca a pagina padrao em branco criada pelo app e reescreve Default/Pages. Faz backup antes.
    So roda com o Stream Deck FECHADO: o app mantem os perfis em memoria e sobrescreveria tudo.
    """
    import shutil
    import time

    profile_dir = Path(profile_dir)
    root_path = profile_dir / "manifest.json"
    if not root_path.is_file():
        raise SystemExit(f"perfil nao encontrado: {profile_dir}")
    if sd_running() and not force:
        raise SystemExit("O Stream Deck esta aberto. Feche-o pela bandeja (Quit) e rode de novo.")

    backup = Path(os.environ.get("APPDATA", ".")) / "Elgato" / "StreamDeck" / (
        f"backup-perfil-{profile_dir.stem}-{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copytree(profile_dir, backup)
    print("backup:", backup)

    root = json.loads(root_path.read_text(encoding="utf-8-sig"))
    pages_dir = profile_dir / "Profiles"
    existing = {}  # nome -> id (minusculo)
    blank = []
    for d in pages_dir.iterdir():
        if not d.is_dir():
            continue
        m = json.loads((d / "manifest.json").read_text(encoding="utf-8-sig"))
        n_actions = sum(1 for c in m.get("Controllers", []) for v in (c.get("Actions") or {}).values() if v)
        if m.get("Name"):
            existing[m["Name"]] = d.name.lower()
        elif n_actions == 0:
            blank.append(d)

    ordered, created = [], []
    for page in variant["pages"]:
        pid = existing.get(page["name"])
        if pid is None:
            pid = page_id(variant, page).lower()
            d = pages_dir / pid.upper()
            d.mkdir(parents=True, exist_ok=True)
            (d / "manifest.json").write_text(
                json.dumps(build_page(variant, page, manifests), ensure_ascii=False, indent=2), encoding="utf-8")
            created.append(page["name"])
        ordered.append(pid)

    for d in blank:  # a pagina padrao vazia que o app criou no import
        shutil.rmtree(d)

    root["Pages"] = {"Current": ordered[0], "Default": ordered[0], "Pages": ordered[1:]}
    root_path.write_text(json.dumps(root, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"paginas: {len(ordered)} no total, {len(created)} novas:")
    for n in created:
        print("  +", n)
    if blank:
        print(f"removida(s) {len(blank)} pagina(s) em branco")


def main():
    argv = sys.argv[1:]
    check_only = "--check" in argv
    name = "maquina"
    if "--variant" in argv:
        name = argv[argv.index("--variant") + 1]
    if name not in VARIANTS:
        raise SystemExit(f"variante desconhecida: {name!r} (use: {', '.join(VARIANTS)})")
    variant = VARIANTS[name]

    manifests = load_manifests(needed_plugins(variant["pages"]))
    errors, warnings = validate(variant, manifests)
    for w in warnings:
        print("aviso:", w)
    if errors:
        print("ERROS:")
        for e in errors:
            print("  -", e)
        raise SystemExit(1)

    ids = [page_id(variant, p).lower() for p in variant["pages"]]
    root = {
        "Device": {"Model": DEVICE_MODEL},
        "Name": variant["name"],
        # No modelo do Stream Deck a pagina padrao fica FORA da lista Pages (que traz as demais).
        "Pages": {"Current": ids[0], "Default": ids[0], "Pages": ids[1:]},
        "Version": "3.0",
    }
    pages = variant["pages"]
    print(f"[{name}] {len(pages)} páginas, {sum(len(p['keys']) for p in pages)} teclas, "
          f"{sum(len(p['dials']) for p in pages)} dials — validado contra {len(manifests)} manifests")
    if check_only:
        return

    if "--into" in argv:
        add_into(variant, argv[argv.index("--into") + 1], manifests, force="--force" in argv)
        return

    out = variant["file"]
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{variant['id']}.sdProfile/manifest.json", json.dumps(root, ensure_ascii=False, indent=2))
        for p in pages:
            z.writestr(f"{variant['id']}.sdProfile/Profiles/{page_id(variant, p)}/manifest.json",
                       json.dumps(build_page(variant, p, manifests), ensure_ascii=False, indent=2))
    print("gravado:", out)


if __name__ == "__main__":
    main()
