/**
 * 鄭哲愷 Web GIS 專案核心邏輯 - 效能優化版
 */

const map = L.map('map', { zoomControl: false }).setView([25.04, 121.4], 11);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png').addTo(map);

const allStations = ["基隆", "汐止", "萬里", "新店", "土城", "板橋", "新莊", "菜寮", "林口", "淡水", "大同", "中山", "萬華", "古亭", "松山", "陽明", "桃園", "大園", "觀音", "平鎮", "龍潭", "中壢", "三重", "永和"];
let monthlyCache = {}, aqiLayer, weatherChart, aqi24hChart;
let currentStationName = null;

// --- 新增：紀錄最後一次渲染圖表的日期與站點 ---
let lastRenderedKey = ""; 

// 1. 初始化時間選取器
const ySel = document.getElementById('yearSelect');
const mSel = document.getElementById('monthSelect');
const dSel = document.getElementById('daySelect');

for(let y=2019; y<=2023; y++) ySel.add(new Option(y, y));
for(let m=1; m<=12; m++) mSel.add(new Option(m, m));

function updateDayOptions() {
    const days = new Date(ySel.value, mSel.value, 0).getDate();
    dSel.innerHTML = '';
    for(let d=1; d<=days; d++) dSel.add(new Option(d, d));
    updateMap();
}

[ySel, mSel].forEach(s => s.onchange = updateDayOptions);
dSel.onchange = updateMap;
document.getElementById('timeSlider').oninput = updateMap;

// 2. 測站標籤
const tagContainer = document.getElementById('stationTags');
allStations.forEach(s => {
    const div = document.createElement('div');
    div.className = 'tag-item active';
    div.innerText = s;
    div.onclick = function() { 
        this.classList.toggle('active'); 
        updateMap(); 
    };
    tagContainer.appendChild(div);
});

function toggleAllTags(status) {
    document.querySelectorAll('.tag-item').forEach(t => status ? t.classList.add('active') : t.classList.remove('active'));
    updateMap();
}

// 3. 地圖更新核心
async function updateMap() {
    const y = ySel.value, m = mSel.value.padStart(2, '0'), d = dSel.value.padStart(2, '0');
    const h = document.getElementById('timeSlider').value.padStart(2, '0');
    const monthKey = `${y}-${m}`, timeKey = `${y}${m}${d}_${h}`;
    const fullDate = `${y}-${m}-${d}`;
    
    document.getElementById('currentTimeLabel').innerText = `${fullDate} ${h}:00`;

    try {
        if (!monthlyCache[monthKey]) {
            const res = await fetch(`https://raw.githubusercontent.com/Kai0514/Repo_1/main/Air_Pollution_Data/web_data/data_json_monthly/${monthKey}.json`);
            if (!res.ok) throw new Error("File not found");
            const raw = await res.text();
            monthlyCache[monthKey] = JSON.parse(raw.replace(/:NaN/g, ":null"));
        }

        const data = monthlyCache[monthKey][timeKey];
        if (!data) return;

        const activeStations = Array.from(document.querySelectorAll('.tag-item.active')).map(t => t.innerText);
        if (aqiLayer) map.removeLayer(aqiLayer);

        aqiLayer = L.geoJson(data, {
            filter: (f) => activeStations.includes(f.properties.s),
            pointToLayer: (f, latlng) => L.circleMarker(latlng, {
                radius: 13, fillColor: f.properties.c, color: "#fff", weight: 2, fillOpacity: 0.9
            }),
            onEachFeature: (f, layer) => {
                layer.on('click', () => { 
                    currentStationName = f.properties.s; 
                    processAnalysis(fullDate, true); // 手動點擊，觸發展開
                });
            }
        }).addTo(map);

        // 如果目前有選中測站，則更新資料
        if (currentStationName) processAnalysis(fullDate);

    } catch (e) { console.warn("數據加載中..."); }
}

function toggleDrawer() {
    if (window.innerWidth <= 768) {
        const panel = document.getElementById('detailPanel');
        panel.classList.toggle('expanded');
    }
}

// 4. 分析邏輯：拆分為「文字更新」與「圖表渲染」
// 4. 分析邏輯：拆分為「文字更新」與「圖表渲染」
function processAnalysis(dateStr, isManualClick = false) { // 增加一個參數判斷是否為手動點擊
    const hour = document.getElementById('timeSlider').value.padStart(2, '0');
    const timeKey = dateStr.replace(/-/g, '') + '_' + hour;
    const currentMonth = dateStr.substring(0, 7);
    
    // 確保數據存在
    if (!monthlyCache[currentMonth] || !monthlyCache[currentMonth][timeKey]) return;
    
    const stationData = monthlyCache[currentMonth][timeKey].features.find(f => f.properties.s === currentStationName);
    if (!stationData) return;
    
    const p = stationData.properties;
    
    // (A) 更新文字與即時數值
    document.getElementById('detailPanel').style.display = 'block';
    document.getElementById('viewName').innerText = p.s + ' 觀測站';
    document.getElementById('viewAQI').innerText = 'AQI ' + (p.a || '--');
    document.getElementById('viewAQI').style.color = p.c;
    document.getElementById('viewDetail').innerHTML = `溫度：${p.t}°C | 降雨：${p.r || 0}mm<br>PM2.5：${p.p} μg/m³`;

    // (B) 檢查是否需要重新渲染圖表 (日期改變 或 換站時才重畫)
    const renderKey = `${dateStr}_${currentStationName}`;
    if (renderKey !== lastRenderedKey) {
        renderCharts(dateStr, p);
        lastRenderedKey = renderKey; 
        console.log("圖表已更新為：" + renderKey);
    }
    
    // (C) 手機版行為優化：只有在「點擊地圖測站」時才自動展開面板
    if (window.innerWidth <= 768 && isManualClick) {
        document.getElementById('detailPanel').classList.add('expanded');
    }
}

// 5. 獨立的圖表渲染函式[cite: 3]
function renderCharts(dateStr, p) {
    const labels = Array.from({length: 24}, (_, i) => `${i}:00`);

    // 溫雨雙軸圖
    const ctxW = document.getElementById('weatherChart').getContext('2d');
    if (weatherChart) weatherChart.destroy();
    
    weatherChart = new Chart(ctxW, {
        data: {
            labels: labels,
            datasets: [
                { 
                    type: 'line', label: '溫度 (°C)', 
                    data: getDailySeries(p.s, dateStr, 't'), 
                    borderColor: '#f1c40f', backgroundColor: '#f1c40f',
                    yAxisID: 'yTemp', tension: 0.4, borderWeight: 3, pointRadius: 2 
                },
                { 
                    type: 'bar', label: '降雨 (mm)', 
                    data: getDailySeries(p.s, dateStr, 'r'), 
                    backgroundColor: 'rgba(52, 152, 219, 0.5)',
                    yAxisID: 'yRain', barPercentage: 0.6 
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                yTemp: { position: 'left', ticks: { count: 6 }, grace: '10%' },
                yRain: { position: 'right', ticks: { count: 6 }, grace: '10%', grid: { drawOnChartArea: false } }
            }
        }
    });

    // AQI 趨勢圖
    const ctxA = document.getElementById('aqi24hChart').getContext('2d');
    if (aqi24hChart) aqi24hChart.destroy();
    aqi24hChart = new Chart(ctxA, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{ 
                label: 'AQI', 
                data: getDailySeries(p.s, dateStr, 'a'), 
                borderColor: p.c, backgroundColor: p.c + '22', 
                fill: true, tension: 0.4 
            }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
}

// 輔助函式：提取 24H 數據序列
function getDailySeries(stationName, dateStr, key) {
    const currentMonth = dateStr.substring(0, 7);
    const datePrefix = dateStr.replace(/-/g, '');
    let series = [];
    for (let h = 0; h < 24; h++) {
        const data = monthlyCache[currentMonth][`${datePrefix}_${h.toString().padStart(2, '0')}`];
        const st = data ? data.features.find(f => f.properties.s === stationName) : null;
        series.push(st ? st.properties[key] : null);
    }
    return series;
}



updateDayOptions();