{{/*
Expand the name of the chart.
*/}}
{{- define "orchestream-ai.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "orchestream-ai.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "orchestream-ai.labels" -}}
helm.sh/chart: {{ include "orchestream-ai.name" . }}-{{ .Chart.Version | replace "+" "_" }}
{{ include "orchestream-ai.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "orchestream-ai.selectorLabels" -}}
app.kubernetes.io/name: {{ include "orchestream-ai.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Secret name — the chart-created secret, or an external one referenced via
Values.existingSecret (preferred for production).
*/}}
{{- define "orchestream-ai.secretName" -}}
{{- .Values.existingSecret | default (printf "%s-secret" (include "orchestream-ai.fullname" .)) }}
{{- end }}

{{/*
Database URL
*/}}
{{- define "orchestream-ai.databaseUrl" -}}
{{- if .Values.databaseUrl }}
{{- .Values.databaseUrl }}
{{- else }}
{{- $dbPassword := .Values.dbPassword | required "dbPassword must be set (or provide databaseUrl / existingSecret)" }}
{{- printf "postgres://%s:%s@%s-postgres:%s/%s" .Values.dbUser $dbPassword (include "orchestream-ai.fullname" .) "5432" .Values.dbName }}
{{- end }}
{{- end }}
