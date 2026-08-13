/*
 * Surge Monitor
 */

const args = parseArgs();
const API_KEY = args.key || "";
const PORT = args.port || "6171";
const METRICS_URL = `http://127.0.0.1:${PORT}/v1/metrics`;

function parseArgs() {
    if (typeof $argument === "undefined" || !$argument) return {};
    return $argument.split("&").reduce((acc, item) => {
        const [k, v] = item.split("=");
        if (k && v) acc[k.trim()] = decodeURIComponent(v.trim());
        return acc;
    }, {});
}

function isFiniteNumber(value) {
    return isFinite(Number(value));
}

function formatBytes(value) {
    if (!isFiniteNumber(value)) return "—";
    let bytes = Math.max(0, Number(value));
    const units = ["B", "KB", "MB", "GB", "TB"];
    let unitIndex = 0;
    while (bytes >= 1024 && unitIndex < units.length - 1) {
        bytes /= 1024;
        unitIndex++;
    }
    return bytes.toFixed(2) + " " + units[unitIndex];
}

function formatSpeed(bytesPerSec) {
    if (!isFiniteNumber(bytesPerSec) || bytesPerSec < 0) return "—/s";
    return formatBytes(bytesPerSec) + "/s";
}

function formatUptime(value) {
    if (!isFiniteNumber(value)) return "—";
    let seconds = Math.max(0, Math.floor(Number(value)));
    const days = Math.floor(seconds / 86400);
    seconds -= days * 86400;
    const hours = Math.floor(seconds / 3600);
    seconds -= hours * 3600;
    const minutes = Math.floor(seconds / 60);
    seconds -= minutes * 60;

    const parts = [];
    if (days > 0) parts.push(days + "天");
    if (hours > 0 || days > 0) parts.push(hours + "小时");
    if (minutes > 0 || hours > 0 || days > 0) parts.push(minutes + "分钟");
    if (parts.length === 0) parts.push(seconds + "秒");

    return parts.join(" ");
}

function parseMetrics(text) {
    const metrics = [];
    const lines = String(text).split(/\r?\n/);
    const metricPattern = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)$/;
    const labelPattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.charAt(0) === "#") continue;

        const match = line.match(metricPattern);
        if (!match) continue;

        const labels = {};
        const labelText = match[2] || "";
        let labelMatch;

        labelPattern.lastIndex = 0;
        while ((labelMatch = labelPattern.exec(labelText)) !== null) {
            labels[labelMatch[1]] = labelMatch[2]
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, "\\");
        }

        metrics.push({
            name: match[1],
            labels: labels,
            value: Number(match[3])
        });
    }

    return metrics;
}

function getMetric(metrics, metricName) {
    for (let i = 0; i < metrics.length; i++) {
        if (metrics[i].name === metricName) return metrics[i];
    }
    return null;
}

function sumMetrics(metrics, metricName) {
    let total = 0;
    let found = false;

    for (let i = 0; i < metrics.length; i++) {
        if (metrics[i].name === metricName && isFiniteNumber(metrics[i].value)) {
            total += Number(metrics[i].value);
            found = true;
        }
    }

    return found ? total : NaN;
}

function getInterfaceDetails(metrics) {
    const ifaces = {};
    for (let i = 0; i < metrics.length; i++) {
        const m = metrics[i];
        const name = m.labels && m.labels.interface;
        
        if (!name || name === "lo0" || name === "lo") continue;

        if (!ifaces[name]) ifaces[name] = { in: 0, out: 0 };
        if (m.name === "surge_interface_in_bytes_total") {
            ifaces[name].in = m.value;
        } else if (m.name === "surge_interface_out_bytes_total") {
            ifaces[name].out = m.value;
        }
    }
    return ifaces;
}

function finishPanel(title, content, style, icon, iconColor) {
    const result = { title: title, content: content };
    if (style) result.style = style;
    if (icon) result.icon = icon;
    if (iconColor) result["icon-color"] = iconColor;
    $done(result);
}

$httpClient.get(
    {
        url: METRICS_URL,
        headers: { Accept: "text/plain", "X-Key": API_KEY }
    },
    function (error, response, body) {
        if (error || !response || response.status < 200 || response.status >= 300 || !body) {
            finishPanel("Surge Monitor", "无法获取 Metrics 数据", "error", "exclamationmark.triangle.fill", "#FF3B30");
            return;
        }

        const metrics = parseMetrics(body);
        const buildInfo = getMetric(metrics, "surge_build_info");
        const uptime = getMetric(metrics, "surge_uptime_seconds");
        const memory = getMetric(metrics, "surge_memory_bytes");

        const version = buildInfo?.labels?.version || "未知";
        const build = buildInfo?.labels?.build || "未知";
        const system = buildInfo?.labels?.system || "未知";

        const downloadTotal = sumMetrics(metrics, "surge_interface_in_bytes_total");
        const uploadTotal = sumMetrics(metrics, "surge_interface_out_bytes_total");

        // 计算实时网速
        const now = Date.now();
        let downSpeed = NaN;
        let upSpeed = NaN;

        const lastDataStr = $persistentStore.read("surge_monitor_last_metrics");
        if (lastDataStr) {
            try {
                const lastData = JSON.parse(lastDataStr);
                const timeDiff = (now - lastData.time) / 1000;
                if (timeDiff > 0 && isFiniteNumber(downloadTotal) && isFiniteNumber(uploadTotal)) {
                    downSpeed = Math.max(0, (downloadTotal - lastData.download)) / timeDiff;
                    upSpeed = Math.max(0, (uploadTotal - lastData.upload)) / timeDiff;
                }
            } catch (e) {}
        }

        $persistentStore.write(
            JSON.stringify({ time: now, download: downloadTotal, upload: uploadTotal }),
            "surge_monitor_last_metrics"
        );

        // 仅保留纯文字友好显示
        const ifaces = getInterfaceDetails(metrics);
        const ifaceLines = [];
        
        for (const [name, data] of Object.entries(ifaces)) {
            if (data.in === 0 && data.out === 0) continue;

            let displayName = name;
            if (name.startsWith("en")) {
                displayName = "Wi-Fi";
            } else if (name.startsWith("pdp_ip")) {
                displayName = "蜂窝网络";
            } else if (name.startsWith("utun")) {
                displayName = "虚拟网络";
            }

            ifaceLines.push(`  └ ${displayName}: ↓${formatBytes(data.in)}  ↑${formatBytes(data.out)}`);
        }

        const contentLines = [
            `实时速率：↓ ${formatSpeed(downSpeed)}   ↑ ${formatSpeed(upSpeed)}`,
            `累计流量：↓ ${formatBytes(downloadTotal)}   ↑ ${formatBytes(uploadTotal)}`
        ];

        if (ifaceLines.length > 0) {
            contentLines.push(`活跃接口:`);
            contentLines.push(...ifaceLines.slice(0, 4));
        }

        contentLines.push(`内存占用：${formatBytes(memory ? memory.value : NaN)}`);
        contentLines.push(`运行时间：${formatUptime(uptime ? uptime.value : NaN)}`);
        contentLines.push("");
        contentLines.push(`Surge ${version} (${build}) · ${system}`);

        finishPanel(
            "Surge Monitor",
            contentLines.join("\n"),
            null,
            "gearshape.fill",
            "#007AFF"
        );
    }
);
