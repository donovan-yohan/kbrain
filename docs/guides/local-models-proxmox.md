# Local Models on Proxmox (GTX 1080 + Ryzen 5700X)

This guide stands up a local inference server for kbrain's embedding and chat
needs, replacing OpenAI and Anthropic API calls with self-hosted models.
Baseline target: GTX 1080 (8GB VRAM, Pascal) + Ryzen 5700X, inside Proxmox.

You can follow this yourself or hand the whole file to an agent running on
the Proxmox host.

---

## What you're building

Two OpenAI-compatible HTTP endpoints on your LAN:

| Endpoint | Port | Model | Purpose |
|----------|------|-------|---------|
| text-embeddings-inference (TEI) | 8080 | Qwen3-Embedding-0.6B | Embedding all ingested content |
| Ollama (or vLLM) | 11434 | Qwen3-4B-Instruct Q5_K_M | Query expansion + Honcho dialogue analysis |

kbrain config points at these URLs. No cloud calls.

---

## Hardware reality check

GTX 1080: 8GB VRAM, Pascal arch (sm_61). Not Ampere — no Tensor cores, no FP8.
CUDA 11.x–12.x both work. Pascal is officially supported by text-embeddings-inference
and Ollama (llama.cpp).

VRAM budget with both models always loaded:

| Component | VRAM | Notes |
|-----------|------|-------|
| Qwen3-Embedding-0.6B (FP16) | ~1.2 GB | TEI memory-resident |
| Qwen3-4B-Instruct Q5_K_M | ~3.0 GB | Ollama memory-resident |
| CUDA kernel overhead + KV cache | ~1.5 GB | Varies with batch size |
| **Total** | **~5.7 GB** | Leaves 2.3 GB headroom |

If you later want Qwen3-8B for Honcho dialogue analysis, use Q4_K_M (~5 GB) and
configure Ollama to unload the 4B when 8B is requested (`OLLAMA_NUM_PARALLEL=1`,
`OLLAMA_MAX_LOADED_MODELS=1`). Or offload embedding to CPU during dialogue
analysis.

---

## Proxmox setup: LXC vs VM

**Recommended: unprivileged LXC container with GPU passthrough.** Lower overhead
than a VM, shares the host kernel's NVIDIA driver, easier snapshot/backup.

Alternative: Ubuntu Server VM with full GPU passthrough (PCIe). More isolated,
more overhead, more config drift.

This guide uses LXC.

---

## Step 1: install NVIDIA driver on Proxmox host

SSH to your Proxmox host as root.

```bash
# Check Debian version Proxmox is on (bookworm or newer recommended)
lsb_release -a

# Install prerequisites
apt update
apt install -y build-essential pve-headers-$(uname -r)

# Download NVIDIA driver (use a version known to work with Pascal — 550.x series is fine)
# Pick the latest "Production Branch" driver from NVIDIA that supports sm_61.
cd /tmp
wget https://us.download.nvidia.com/XFree86/Linux-x86_64/550.120/NVIDIA-Linux-x86_64-550.120.run
chmod +x NVIDIA-Linux-x86_64-550.120.run
./NVIDIA-Linux-x86_64-550.120.run --no-questions --ui=none --disable-nouveau

# Verify
nvidia-smi
# You should see "GeForce GTX 1080" and driver version 550.120
```

If `nvidia-smi` fails with "No devices found", confirm the 1080 is passed
through to the host (not grabbed by a different VM) and that `nouveau` is
blacklisted.

---

## Step 2: create the LXC container

From the Proxmox web UI or `pct` CLI:

```bash
# On the Proxmox host
pct create 200 local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst \
  --hostname brain-inference \
  --memory 16384 \
  --cores 8 \
  --rootfs local-lvm:64 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 \
  --features nesting=1
```

64 GB disk, 16 GB RAM, 8 cores. Tune to taste.

**Attach GPU to the container.** Edit `/etc/pve/lxc/200.conf` on the Proxmox host:

```
# NVIDIA GPU passthrough for unprivileged LXC
lxc.cgroup2.devices.allow: c 195:* rwm
lxc.cgroup2.devices.allow: c 234:* rwm
lxc.cgroup2.devices.allow: c 510:* rwm
lxc.mount.entry: /dev/nvidia0 dev/nvidia0 none bind,optional,create=file
lxc.mount.entry: /dev/nvidiactl dev/nvidiactl none bind,optional,create=file
lxc.mount.entry: /dev/nvidia-uvm dev/nvidia-uvm none bind,optional,create=file
lxc.mount.entry: /dev/nvidia-uvm-tools dev/nvidia-uvm-tools none bind,optional,create=file
lxc.mount.entry: /dev/nvidia-modeset dev/nvidia-modeset none bind,optional,create=file
```

Start the container:

```bash
pct start 200
pct enter 200
```

Inside the container:

```bash
# Install the same NVIDIA driver INSIDE the container — drivers only, no kernel module
cd /tmp
apt update && apt install -y wget build-essential
wget https://us.download.nvidia.com/XFree86/Linux-x86_64/550.120/NVIDIA-Linux-x86_64-550.120.run
chmod +x NVIDIA-Linux-x86_64-550.120.run
./NVIDIA-Linux-x86_64-550.120.run --no-kernel-module --no-questions --ui=none

# Verify
nvidia-smi
```

If `nvidia-smi` works inside the LXC, GPU passthrough is good.

---

## Step 3: install Docker inside the LXC

```bash
apt install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu jammy stable" > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Install NVIDIA container toolkit
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' > /etc/apt/sources.list.d/nvidia-container-toolkit.list
apt update
apt install -y nvidia-container-toolkit
nvidia-ctk runtime configure --runtime=docker
systemctl restart docker

# Verify Docker sees the GPU
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

You should see the 1080 from inside the container from inside Docker. Inception complete.

---

## Step 4: run text-embeddings-inference (TEI) for Qwen3-Embedding

```bash
mkdir -p /opt/tei/data
docker run -d --name tei \
  --restart unless-stopped \
  --gpus all \
  -p 8080:80 \
  -v /opt/tei/data:/data \
  ghcr.io/huggingface/text-embeddings-inference:1.5 \
  --model-id Qwen/Qwen3-Embedding-0.6B \
  --dtype float16 \
  --max-batch-tokens 16384 \
  --max-client-batch-size 64
```

Check logs:

```bash
docker logs -f tei
# Wait for "Ready"
```

Test:

```bash
curl http://localhost:8080/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model": "Qwen/Qwen3-Embedding-0.6B", "input": "the quick brown fox"}' \
  | jq '.data[0].embedding | length'
# Should print 1024
```

Confirm dim is 1024. That's what kbrain will be configured to use.

---

## Step 5: run Ollama for query expansion (Qwen3-4B-Instruct)

```bash
docker run -d --name ollama \
  --restart unless-stopped \
  --gpus all \
  -p 11434:11434 \
  -v /opt/ollama:/root/.ollama \
  ollama/ollama

# Pull the model
docker exec -it ollama ollama pull qwen2.5:3b-instruct
# (qwen3:4b-instruct may not yet be in the Ollama library at time of writing —
#  use qwen2.5:3b-instruct, qwen2.5:7b-instruct-q4_K_M, or llama3.1:8b-instruct-q4_K_M
#  as near-equivalents. Upgrade when Qwen3 lands.)

# Test
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen2.5:3b-instruct", "messages": [{"role":"user","content":"say hi"}]}'
```

Ollama exposes an OpenAI-compatible endpoint at `/v1`. That's what kbrain talks to.

---

## Step 6: find the LXC's IP on your LAN

```bash
ip -4 addr show eth0 | grep inet
# e.g. 192.168.1.42
```

Your desktop/laptop (where kbrain runs) will hit:
- `http://192.168.1.42:8080/v1` — embeddings
- `http://192.168.1.42:11434/v1` — chat

Consider a static lease in your router DHCP or an internal DNS name like
`brain.lan` so kbrain's config doesn't break when the container reboots.

---

## Step 7: configure kbrain

On the machine running kbrain, edit `~/.gbrain/config.json`:

```json
{
  "engine": "pglite",
  "database_path": "/Users/you/.gbrain/brain.pglite",
  "embedding_base_url": "http://brain.lan:8080/v1",
  "embedding_model": "Qwen/Qwen3-Embedding-0.6B",
  "embedding_dimensions": 1024,
  "expansion_provider": "openai-compat",
  "expansion_base_url": "http://brain.lan:11434/v1",
  "expansion_model": "qwen2.5:3b-instruct",
  "expansion_api_key": "sk-local"
}
```

Or set env vars:

```bash
export EMBEDDING_BASE_URL=http://brain.lan:8080/v1
export EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
export EMBEDDING_DIMENSIONS=1024
export EXPANSION_PROVIDER=openai-compat
export EXPANSION_BASE_URL=http://brain.lan:11434/v1
export EXPANSION_MODEL=qwen2.5:3b-instruct
```

**Important: on a fresh brain, init with the new dimension FIRST.** The schema
bakes the vector dimension into the `content_chunks.embedding` column. Once a
brain is initialized at 1024, it stays at 1024.

```bash
gbrain init --pglite
```

For an existing brain on 1536, see **Migration** below.

---

## Step 8: test end-to-end

```bash
# Ingest something
echo "# test article\n\nThis is a test of local embeddings." > /tmp/test.md
gbrain put test /tmp/test.md

# Search (triggers embedding + query expansion)
gbrain search "test article"

# You should see results and no network calls to api.openai.com or api.anthropic.com
# Verify with: `tcpdump -i any -n host api.openai.com or host api.anthropic.com`
# — should see zero packets during a query.
```

---

## Migration: existing 1536-dim brain → 1024-dim local

`gbrain` does not yet ship an automated swap command. Manual path:

```bash
# 1. Export the brain
gbrain export --out /tmp/brain-export.json

# 2. Back up the old database
cp ~/.gbrain/brain.pglite ~/.gbrain/brain.pglite.backup

# 3. Remove the old database (schema is dim-locked)
rm ~/.gbrain/brain.pglite

# 4. Configure local embedding provider (see Step 7)

# 5. Re-init at new dimension
gbrain init --pglite

# 6. Re-import content
gbrain import /tmp/brain-export.json

# 7. Regenerate embeddings with the new provider
gbrain embed --all
```

Budget 1-2 minutes per 1000 pages on the 1080 for re-embedding.

---

## Honcho integration (optional)

Honcho can share these endpoints:
- Honcho's embedding layer → point at `http://brain.lan:8080/v1` (Qwen3-Embedding)
- Honcho's dialogue LLM → point at `http://brain.lan:11434/v1` with `qwen2.5:3b-instruct`
  or a larger model if quality is insufficient

No duplication. One GPU serving both tools.

---

## Operational notes

**Auto-start on boot**

The `--restart unless-stopped` flag on both Docker containers handles this.
Proxmox LXCs can be set to autostart via the web UI: select container →
Options → Start at boot → Yes.

**Monitoring**

```bash
# Watch GPU utilization + VRAM
watch -n 1 nvidia-smi

# Watch container logs
docker logs -f tei
docker logs -f ollama
```

**Updating models**

```bash
# New TEI version
docker pull ghcr.io/huggingface/text-embeddings-inference:latest
docker stop tei && docker rm tei
# re-run the docker run command from Step 4

# New Ollama model
docker exec -it ollama ollama pull qwen2.5:7b-instruct-q4_K_M
# Then update EXPANSION_MODEL in kbrain config
```

**If inference gets slow**

- Check `nvidia-smi` — is VRAM near limit? Unload one model.
- Check `docker logs` — is TEI OOM-killing batches? Lower `--max-batch-tokens`.
- Check host CPU — is something else eating cores? Pin containers to specific
  cores via LXC config (`lxc.cgroup2.cpuset.cpus`).

**If you upgrade to a Turing+ GPU later**

Turing (RTX 20xx) and newer support Tensor cores and FP8/INT4 quantization,
giving 3-10x throughput on the same models. The config doesn't change — just
swap the card, update drivers, restart the containers.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `nvidia-smi` works on host but not in LXC | Cgroup device allow missing | Check `/etc/pve/lxc/200.conf` — all 5 mount entries present |
| TEI logs "no compatible CUDA" | Pascal is too old for current TEI version | Pin TEI to `:1.5` tag (supports Pascal) or upgrade GPU |
| kbrain search returns nothing | Dim mismatch — embedded at 1024 but schema is 1536 | Re-init at 1024 or re-configure to match |
| "Embedding dimension mismatch" error | Config says 1024, server emits 768 | Check which model TEI is actually running: `curl localhost:8080/info` |
| Ollama returns `{"error":"model not found"}` | Model name mismatch | `docker exec ollama ollama list` to see what's installed |
| Slow first query after idle | Models unloaded from VRAM | Ollama: set `OLLAMA_KEEP_ALIVE=24h` |

---

## Cost comparison

| Component | Cloud | Local (GTX 1080 LXC) |
|-----------|-------|----------------------|
| Embeddings (1M tokens/mo) | $0.13 | $0 + ~15W idle power |
| Query expansion (Anthropic Haiku) | ~$0.10/mo | $0 + compute cost |
| Transcription (not covered here) | $0.12/hr | Local whisper.cpp — similar setup |
| **Monthly total for light use** | **~$1-5** | **~$5 electricity** |

Cost isn't the reason to do this — privacy and control are.
