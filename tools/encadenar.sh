#!/usr/bin/env bash
# Encadena la corrida siguiente de un workflow, con reintentos si la API de GitHub falla
# (el 25-11 respondió 500/502 de 12:52 a 13:13 y se cortaron SGDC, Dhemax y Planillón).
#
# Uso: bash tools/encadenar.sh WORKFLOW HORARIO [ANTES]
#   HORARIO: siempre | turno (08:15–18:15, 21:45–07:45) | planillon (05:00–00:25; el robot lee hasta 00:30)
#   ANTES=1 (solo turno): lanzado con "Iniciar turno"; fuera de la ventana encadena con -f turno=true.
#   sgdc.yml siempre encadena con -f vigilar=true.
#
# Reintentos: al tiro, a los 5, 10 y 15 min, y después cada 30 min (hasta ~4 h).
# Mientras espera, cada minuto mira si ya hay otra corrida en cola (la lanzó el cron, el respaldo del
# vigilante, "Iniciar turno" o un pedido que GitHub aceptó aunque respondió error). Si la hay, sale:
# esta corrida tiene tomada la concurrencia y la otra no parte hasta que esta termine.
# Necesita GH_TOKEN, GITHUB_REPOSITORY, GITHUB_REF_NAME y GITHUB_RUN_ID (los pone Actions).

set -u
WF="$1"
HORARIO="$2"
ANTES="${3:-0}"
ESPERAS=(5 5 5 30 30 30 30 30 30 30 30) # minutos antes de cada reintento (≈ 4 h 15 min en total)

hora() { echo $((10#$(TZ=America/Santiago date +%H%M))); }

# Argumentos de la corrida siguiente, o "no" si ya no corresponde encadenar.
argumentos() {
  local hm; hm=$(hora)
  case "$HORARIO" in
    siempre)
      [ "$WF" = "sgdc.yml" ] && echo "-f vigilar=true" || echo "" ;;
    turno)
      if { [ $hm -ge 815 ] && [ $hm -lt 1815 ]; } || [ $hm -ge 2145 ] || [ $hm -lt 745 ]; then echo ""
      elif [ "$ANTES" = "1" ]; then echo "-f turno=true"
      else echo "no"; fi ;;
    planillon)
      # Hasta las 00:25: una corrida lanzada después solo alcanza a hacer 1 pasada antes de las 00:30
      # y vuelve a encadenar (el 26-11 se lanzaron 6 seguidas entre 00:27 y 00:30).
      if [ $hm -ge 500 ] || [ $hm -lt 25 ]; then echo ""; else echo "no"; fi ;;
    *) echo "no" ;;
  esac
}

# ¿Hay otra corrida de este workflow esperando? (Mientras esta corre, otra del mismo grupo solo puede estar en cola.)
hay_en_cola() {
  local n
  n=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/$WF/runs?per_page=20" \
        --jq "[.workflow_runs[] | select(.id != $GITHUB_RUN_ID and (.status == \"queued\" or .status == \"pending\" or .status == \"waiting\" or .status == \"requested\"))] | length" \
        2>/dev/null) || return 1
  [ "${n:-0}" -gt 0 ]
}

intento=0
while :; do
  args=$(argumentos)
  if [ "$args" = "no" ]; then
    echo "Terminó el horario ($(hora)): no se encadena."
    exit 0
  fi
  intento=$((intento + 1))
  # shellcheck disable=SC2086
  if gh workflow run "$WF" --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME" $args; then
    echo "Se pidió la corrida siguiente ($(hora)${args:+, $args}; intento $intento)."
    exit 0
  fi
  if [ $intento -gt ${#ESPERAS[@]} ]; then
    echo "::error::No se pudo encadenar $WF tras $intento intentos. Queda el cron */30 y el respaldo del vigilante."
    exit 1
  fi
  espera=${ESPERAS[$((intento - 1))]}
  echo "::warning::Falló el pedido a GitHub (intento $intento). Reintento en $espera min."
  for ((m = 0; m < espera; m++)); do
    sleep 60
    if hay_en_cola; then
      echo "Ya hay otra corrida de $WF en cola: no hace falta encadenar."
      exit 0
    fi
  done
done
