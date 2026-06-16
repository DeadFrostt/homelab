#!/usr/bin/env bash
# Validate every app directory the way the ArgoCD `kustomize-envsubst` CMP plugin
# builds it (argocd/cmp-plugin-cm.yaml), then schema-check the output with kubeconform.
#
#   - dir has kustomization.yaml -> `kustomize build --enable-helm .`
#   - otherwise                  -> concatenate its *.yaml files
#
# envsubst `$VAR` placeholders all live inside ConfigMap string data, so they
# validate fine as-is without the real values (which CI never has anyway).
#
# Requires kustomize, kubeconform and helm on PATH. Run from the repo root.
set -uo pipefail

# CRDs not in the default Kubernetes schemas (InfisicalSecret, CNPG Cluster,
# ArgoCD types, …) are looked up in the community catalog; anything still
# unknown is skipped rather than failing the run.
CATALOG='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

fail=0
for dir in */; do
  dir="${dir%/}"
  case "$dir" in
    docs|.github|.claude) continue ;;
  esac
  ls "$dir"/*.yaml >/dev/null 2>&1 || continue

  echo "::group::$dir"
  if [ -f "$dir/kustomization.yaml" ]; then
    if ! render=$(cd "$dir" && kustomize build --enable-helm . 2>&1); then
      echo "kustomize build failed for $dir:"
      echo "$render"
      fail=1
      echo "::endgroup::"
      continue
    fi
  else
    render=$(for f in "$dir"/*.yaml; do printf '\n---\n'; cat "$f"; done)
  fi

  if ! printf '%s' "$render" | kubeconform \
      -strict -summary -ignore-missing-schemas \
      -schema-location default \
      -schema-location "$CATALOG"; then
    fail=1
  fi
  echo "::endgroup::"
done

exit "$fail"
