import React, { useState, useEffect, useMemo } from 'react';
import { 
  TrendingUp, 
  TrendingDown, 
  DollarSign, 
  Users, 
  Upload, 
  FileText, 
  Activity, 
  Layers, 
  Info,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  Link2,
  Lock,
  HardDrive,
  ChevronDown,
  ChevronUp
} from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState('cloud'); // 'cloud' | 'raw_paste' | 'upload'
  // 預設為使用者提供的最新 Google Sheets 試算表連結
  const [driveUrl, setDriveUrl] = useState('https://docs.google.com/spreadsheets/d/e/2PACX-1vSoEPmzQQPSf6WIfkASsEPdKkJvO2mVC250oDxt9-4Bis4T7cbNm90UTctKxKYuXx8k2pvdjkEE8zWY/pubhtml');
  const [rawText, setRawText] = useState('');
  
  const [selectedEtf, setSelectedEtf] = useState('');
  const [selectedDayDetail, setSelectedDayDetail] = useState('');
  
  // 數據載入狀態
  const [loadedData, setLoadedData] = useState({});
  const [syncStatus, setSyncStatus] = useState('idle'); // 'idle' | 'loading' | 'success' | 'error'
  const [errorMessage, setErrorMessage] = useState('');
  const [showHowToPublish, setShowHowToPublish] = useState(false);

  // ==================== CSV 語法解析引擎 ====================
  const parseCsvToData = (text) => {
    try {
      if (!text || text.trim() === '') return {};
      // 處理可能的 Windows \r\n 斷行問題
      const lines = text.split(/\r?\n/);
      if (lines.length < 2) throw new Error('CSV 資料行數不足，無法分析');
      
      const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
      
      const dateIdx = headers.findIndex(h => h.includes('日期') || h.toLowerCase().includes('date'));
      const itemIdx = headers.findIndex(h => h.includes('項目') || h.toLowerCase().includes('item'));
      const valueIdx = headers.findIndex(h => h.includes('數值') || h.toLowerCase().includes('value'));
      const etfIdx = headers.findIndex(h => h.includes('ETF類別') || h.includes('類別') || h.includes('代號') || h.toLowerCase().includes('etf'));

      if (dateIdx === -1 || itemIdx === -1 || valueIdx === -1) {
        throw new Error('CSV 格式欄位定位失敗，必須包含「資料日期」、「項目」、「數值」等欄位標頭。');
      }

      const tempMap = {};

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // 簡單處理 CSV 有雙引號與逗號的欄位分割
        const cells = line.split(',').map(c => c.trim().replace(/^["']|["']$/g, ''));
        if (cells.length < 3) continue;

        const date = cells[dateIdx];
        const item = cells[itemIdx];
        // 移除數值中可能存在的千分位逗號
        const cleanValStr = cells[valueIdx].replace(/,/g, '');
        const value = parseFloat(cleanValStr || '0');
        const etf = etfIdx !== -1 ? cells[etfIdx] : '00981A';

        if (!date || !item || isNaN(value)) continue;

        if (!tempMap[etf]) tempMap[etf] = {};
        if (!tempMap[etf][date]) tempMap[etf][date] = {};

        tempMap[etf][date][item] = value;
      }

      const resultData = {};
      Object.keys(tempMap).forEach(etf => {
        const dates = Object.keys(tempMap[etf]).sort((a, b) => new Date(b) - new Date(a));
        
        resultData[etf] = dates.map((date) => {
          const items = tempMap[etf][date];
          const cash = items['現金'] || 0;
          const receivable = items['應收付證券款'] || 0;
          const redemption = items['申贖應付款'] || 0;
          const netAsset = items['淨資產'] || 0;
          const units = items['流通在外單位數'] || 0;
          const nav = items['每單位淨值'] || 0;

          // 計算公式 1：實際剩餘現金 (元) = 現金 + 應收付證券款 + 申贖應付款
          const actualCashVal = cash + receivable + redemption;
          const actualCash100M = actualCashVal / 100000000; // 轉為億元

          // 計算公式 2：現金佔比 = 實際剩餘現金 / 淨資產 * 100
          const cashRatio = netAsset > 0 ? (actualCashVal / netAsset) * 100 : 0;

          return { date, cash, receivable, redemption, netAsset, units, nav, actualCash100M, cashRatio, rawActualCash: actualCashVal };
        });

        // 重新遍歷以計算「每日增減量」與「市場單位數變化」
        const etfList = resultData[etf];
        for (let i = 0; i < etfList.length; i++) {
          const current = etfList[i];
          const prev = etfList[i + 1]; // 因為日期是由新到舊排序，後一個就是前一天

          if (prev) {
            // 資金每日增減 (億元)
            current.cashChange = current.actualCash100M - prev.actualCash100M;
            
            // 流通單位每日增減 (億單位)
            const currUnits100M = current.units / 100000000;
            const prevUnits100M = prev.units / 100000000;
            current.unitsChange100M = currUnits100M - prevUnits100M;
            
            // 增減比例 (%)
            current.unitsChangeRatio = prevUnits100M > 0 ? (current.unitsChange100M / prevUnits100M) * 100 : 0;
            
            // 預估申贖引發的現金增減 = 每日單位數增減 * 當日淨值
            current.estCashFlow100M = (current.unitsChange100M * 100000000 * current.nav) / 100000000;
          } else {
            // 最早的一天無前一日對比
            current.cashChange = 0;
            current.unitsChange100M = 0;
            current.unitsChangeRatio = 0;
            current.estCashFlow100M = 0;
          }
        }
      });

      return resultData;
    } catch (e) {
      throw new Error(`解析 CSV 發生錯誤：${e.message}`);
    }
  };

  // ==================== 試算表串接與資料處理 ====================
  const extractDriveId = (url) => {
    if (!url) return null;
    const fileIdMatch = url.match(/\/file\/d\/([a-zA-Z0-9-_]+)/) || url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (fileIdMatch) return fileIdMatch[1];
    const idParamMatch = url.match(/[?&]id=([a-zA-Z0-9-_]+)/);
    return idParamMatch ? idParamMatch[1] : null;
  };

  const processLoadedData = (parsed) => {
    const etfKeys = Object.keys(parsed);
    if (etfKeys.length === 0) throw new Error('試算表中未含有任何有效欄位資料');
    setLoadedData(parsed);
    setSyncStatus('success');
    const defaultEtf = etfKeys[0];
    setSelectedEtf(defaultEtf);
    if (parsed[defaultEtf]?.[0]) setSelectedDayDetail(parsed[defaultEtf][0].date);
  };

  const clearDataOnError = () => {
    setLoadedData({});
    setSelectedEtf('');
    setSelectedDayDetail('');
  };

  const fetchCsvFromDrive = async (targetUrl) => {
    setSyncStatus('loading');
    setErrorMessage('');

    let directDownloadUrl = '';
    let isPublishToWeb = false;

    // 1. 處理 Google 試算表「發佈到網路」的連結格式 (/d/e/...)
    if (targetUrl.includes('/d/e/')) {
      isPublishToWeb = true;
      // 將結尾的 /pubhtml 替換為 /pub?output=csv
      const baseUrl = targetUrl.split('/pub')[0];
      directDownloadUrl = `${baseUrl}/pub?output=csv`;
    } 
    // 2. 已經帶有 output=csv 的網址
    else if (targetUrl.includes('output=csv')) {
      isPublishToWeb = true;
      directDownloadUrl = targetUrl;
    } 
    // 3. 一般 Google Drive 共用連結
    else {
      const fileId = extractDriveId(targetUrl);
      if (!fileId) {
        setSyncStatus('error');
        setErrorMessage('無法從輸入網址中提取有效 Google ID。請確認輸入網址是否為 Google 試算表之共用連結。');
        clearDataOnError();
        return;
      }
      // 直接請求該試算表之導出 CSV 端點
      directDownloadUrl = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=csv`;
    }

    let rawText = null;

    // 「發佈到網路」(pub?output=csv) 大多數允許跨域，先嘗試最穩定快速的直接 Fetch
    if (isPublishToWeb) {
      try {
        const directResponse = await fetch(directDownloadUrl);
        if (directResponse.ok) {
          rawText = await directResponse.text();
        }
      } catch (directErr) {
        console.warn('直接 Fetch 發佈網路連結失敗，嘗試啟動代理穿透。');
      }
    }

    // 若直接 Fetch 失敗或為一般共用連結，則啟動多重 Proxy 安全穿透
    if (!rawText) {
      const proxyList = [
        `https://api.allorigins.win/raw?url=${encodeURIComponent(directDownloadUrl)}`,
        `https://corsproxy.io/?${encodeURIComponent(directDownloadUrl)}`
      ];

      for (let i = 0; i < proxyList.length; i++) {
        try {
          const response = await fetch(proxyList[i]);
          if (response.ok) {
            rawText = await response.text();
            if (rawText && !rawText.includes('<!DOCTYPE html>') && !rawText.includes('Sign in - Google Accounts') && !rawText.includes('google.com/accounts')) {
              break; 
            }
          }
        } catch (err) {
          console.warn(`代理節點 ${i+1} 連線阻擋，切換下一組代理...`);
        }
      }
    }

    try {
      if (!rawText || rawText.includes('<!DOCTYPE html>') || rawText.includes('Sign in - Google Accounts') || rawText.includes('google.com/accounts')) {
        throw new Error(
          '未能成功讀取 Google 試算表內容。\n若是發佈到網路的連結，請確保已發佈；若為共用連結，請確認權限已設為「知道連結的任何人均可檢視」。'
        );
      }
      const parsed = parseCsvToData(rawText);
      processLoadedData(parsed);
    } catch (err) {
      setSyncStatus('error');
      setErrorMessage(err.message);
      clearDataOnError();
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setSyncStatus('loading');

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target.result;
        const parsed = parseCsvToData(text);
        processLoadedData(parsed);
        setErrorMessage('');
      } catch (err) {
        setSyncStatus('error');
        setErrorMessage(err.message);
        clearDataOnError();
      }
    };
    reader.onerror = () => {
      setSyncStatus('error');
      setErrorMessage('讀取本地檔案失敗。');
      clearDataOnError();
    };
    reader.readAsText(file);
  };

  const handleRawTextParse = () => {
    if (!rawText.trim()) return;
    setSyncStatus('loading');
    try {
      const parsed = parseCsvToData(rawText);
      processLoadedData(parsed);
      setErrorMessage('');
    } catch (err) {
      setSyncStatus('error');
      setErrorMessage(err.message);
      clearDataOnError();
    }
  };

  // 初始化自動拉取 Google 試算表數據
  useEffect(() => {
    fetchCsvFromDrive(driveUrl);
  }, []);

  // ==================== 數據切片篩選 ====================
  const activeDataset = useMemo(() => loadedData[selectedEtf] || [], [loadedData, selectedEtf]);
  const latestFiveDays = useMemo(() => activeDataset.slice(0, 5), [activeDataset]);
  const selectedDayData = useMemo(() => activeDataset.find(d => d.date === selectedDayDetail) || activeDataset[0] || null, [activeDataset, selectedDayDetail]);

  // ==================== 操盤策略智慧解讀 ====================
  const cashTacticsInterpretation = (dayData) => {
    if (!dayData) return { title: '無數據', text: '暫無數據可供分析。', color: 'bg-slate-800' };
    const change = dayData.cashChange;
    const isPreSpending = dayData.receivable < 0 && Math.abs(dayData.receivable) > dayData.cash;

    if (isPreSpending) return { title: '領錢進攻 ＆ 預支佈局 🚀', text: `今日實際「應收付證券交割款」高達 -${(Math.abs(dayData.receivable)/100000000).toFixed(2)} 億，已超出帳面現金庫存。這代表經理人利用 T+2 交割時差提前「預支」資金買進潛力股。目前處於火力全開的絕對進攻狀態！`, color: 'text-rose-400 bg-rose-500/10 border-rose-500/20' };
    if (change < 0) return { title: '領錢進攻（大舉入市） 🔥', text: `今日實際可用剩餘現金減少 ${Math.abs(change).toFixed(2)} 億。這代表經理人此時正將累積下來的防禦銀彈大舉提領並換成股票持股，操作取態積極強勢！`, color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' };
    return { title: '存錢防禦（累積彈藥） 🛡️', text: `今日實際剩餘可用金增加 ${change.toFixed(2)} 億。主要反映經理人適度主動賣股變現以調節風險；或為當日湧入大筆新申購資金尚來不及布局股票，資金被動累積，為後續保留進攻底牌。`, color: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20' };
  };

  const marketSentimentInterpretation = (dayData) => {
    if (!dayData) return { text: '無數據', trend: '平穩' };
    const ratioChange = dayData.unitsChangeRatio;
    const estFlow = dayData.estCashFlow100M;

    if (ratioChange > 1.5) return { trend: '極度狂熱 📈', text: `流通在外受益單位單日暴增 ${(ratioChange).toFixed(2)}%，推估為基金帶進高達 +${estFlow.toFixed(2)} 億元的搶購狂潮。買盤流入速度正「瘋狂變快」！` };
    if (ratioChange > 0.05) return { trend: '買氣暢旺 👍', text: `大眾申購穩定遞增，流通單位數成長 ${(ratioChange).toFixed(2)}%，挹注新資金約 +${estFlow.toFixed(2)} 億。進場追價速度「穩定加溫」。` };
    if (ratioChange < -0.05) return { trend: '獲利贖回 💰', text: `流通在外單位減少 ${Math.abs(ratioChange).toFixed(2)}%，估計流出金額約 ${Math.abs(estFlow).toFixed(2)} 億。買進速度「正在放慢」，大眾多選擇逢高了結、落袋為安。` };
    return { trend: '靜待變盤 ⚖️', text: `流通單位變動平緩 (${(ratioChange).toFixed(3)}%)。市場目前正處於觀望階段，多空情緒暫時平穩沉澱。` };
  };

  // ==================== 資金水位折線/面積圖 (純 SVG) ====================
  const ChronologicalCashChart = () => {
    const chronologicalDays = useMemo(() => [...latestFiveDays].reverse(), [latestFiveDays]);
    const [hoveredIdx, setHoveredIdx] = useState(null);

    if (chronologicalDays.length === 0) return null;

    const cashValues = chronologicalDays.map(d => d.actualCash100M);
    const maxCash = Math.max(...cashValues, 0.1) * 1.15;
    const minCash = Math.min(...cashValues, 0) < 0 ? Math.min(...cashValues) * 1.15 : 0;
    
    const svgW = 600;
    const svgH = 180;
    const pad = { top: 15, right: 30, bottom: 30, left: 55 };

    const getX = (idx) => pad.left + (idx / (chronologicalDays.length - 1 || 1)) * (svgW - pad.left - pad.right);
    const getY = (val) => {
      const range = maxCash - minCash || 1;
      return svgH - pad.bottom - ((val - minCash) / range) * (svgH - pad.top - pad.bottom);
    };

    const points = chronologicalDays.map((d, idx) => ({ x: getX(idx), y: getY(d.actualCash100M), data: d }));
    const lineD = points.reduce((acc, p, idx) => idx === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`, '');
    const areaD = points.length > 0 
      ? `${lineD} L ${points[points.length - 1].x} ${getY(minCash)} L ${points[0].x} ${getY(minCash)} Z`
      : '';

    const gridLevels = 4;
    const gridLines = Array.from({ length: gridLevels }).map((_, i) => {
      const val = minCash + (i / (gridLevels - 1)) * (maxCash - minCash);
      return { val, y: getY(val) };
    });

    return (
      <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3">
        <div className="flex justify-between items-center">
          <h4 className="text-xs font-bold text-slate-300 flex items-center gap-1.5 font-mono">
            <Activity className="h-3.5 w-3.5 text-cyan-400" />
            CASH TRENDS / 資金剩餘趨勢圖
          </h4>
          <span className="text-[10px] text-slate-500 font-mono">單位：新台幣億元</span>
        </div>

        <div className="relative w-full overflow-hidden">
          <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full h-auto overflow-visible">
            <defs>
              <linearGradient id="cashAreaGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.25" />
                <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.0" />
              </linearGradient>
            </defs>

            {/* Y 軸格線 */}
            {gridLines.map((line, i) => (
              <g key={i}>
                <line x1={pad.left} y1={line.y} x2={svgW - pad.right} y2={line.y} stroke="#1e293b" strokeWidth="1" strokeDasharray="4 4" />
                <text x={pad.left - 8} y={line.y + 3} fill="#64748b" fontSize="9" fontFamily="monospace" textAnchor="end">
                  {line.val.toFixed(2)}
                </text>
              </g>
            ))}

            {/* 零點基準紅線 (當出現 Pre-spending / 預支負現金水位時) */}
            {minCash < 0 && (
              <line x1={pad.left} y1={getY(0)} x2={svgW - pad.right} y2={getY(0)} stroke="#f43f5e" strokeWidth="1" strokeOpacity="0.5" />
            )}

            {areaD && <path d={areaD} fill="url(#cashAreaGrad)" />}
            {lineD && <path d={lineD} fill="none" stroke="#22d3ee" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />}

            {points.map((p, idx) => (
              <g key={idx} onMouseEnter={() => setHoveredIdx(idx)} onMouseLeave={() => setHoveredIdx(null)} className="cursor-pointer">
                <circle cx={p.x} cy={p.y} r={hoveredIdx === idx ? "6" : "4"} fill="#020617" stroke="#22d3ee" strokeWidth={hoveredIdx === idx ? "3.5" : "1.5"} />
                <circle cx={p.x} cy={p.y} r="12" fill="transparent" />
              </g>
            ))}

            {points.map((p, idx) => (
              <text key={idx} x={p.x} y={svgH - 8} fill={hoveredIdx === idx ? "#38bdf8" : "#64748b"} fontSize="9" fontWeight={hoveredIdx === idx ? "bold" : "normal"} textAnchor="middle">
                {p.data.date.substring(5)}
              </text>
            ))}
          </svg>

          {/* 懸浮數據明細浮窗 */}
          {hoveredIdx !== null && (
            <div className="absolute top-1 right-1 bg-slate-900/95 border border-slate-800 p-2.5 rounded-lg shadow-lg text-[11px] space-y-1 pointer-events-none">
              <div className="font-bold text-slate-300 border-b border-slate-800 pb-1">{chronologicalDays[hoveredIdx].date}</div>
              <div className="flex justify-between gap-4 text-slate-400"><span>實際剩餘可用金:</span><span className="font-mono font-bold text-cyan-400">{chronologicalDays[hoveredIdx].actualCash100M.toFixed(4)} 億</span></div>
              <div className="flex justify-between gap-4 text-slate-400"><span>帳面現金佔佔比:</span><span className="font-mono text-slate-300">{chronologicalDays[hoveredIdx].cashRatio.toFixed(3)}%</span></div>
              <div className="flex justify-between gap-4 text-slate-400"><span>單日水位淨增減:</span><span className={`font-mono font-bold ${chronologicalDays[hoveredIdx].cashChange > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{chronologicalDays[hoveredIdx].cashChange > 0 ? '+' : ''}{chronologicalDays[hoveredIdx].cashChange.toFixed(3)} 億</span></div>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ==================== 市場申贖資金流量圖 (純 SVG) ====================
  const ChronologicalSentimentChart = () => {
    const chronologicalDays = useMemo(() => [...latestFiveDays].reverse(), [latestFiveDays]);
    const [hoveredIdx, setHoveredIdx] = useState(null);

    if (chronologicalDays.length === 0) return null;

    const flowValues = chronologicalDays.map(d => d.estCashFlow100M);
    const maxAbsFlow = Math.max(...flowValues.map(Math.abs), 0.5) * 1.25;
    const minFlow = -maxAbsFlow;
    const maxFlow = maxAbsFlow;

    const svgW = 600;
    const svgH = 180;
    const pad = { top: 15, right: 30, bottom: 30, left: 55 };

    const getX = (idx) => pad.left + (idx / (chronologicalDays.length - 1 || 1)) * (svgW - pad.left - pad.right);
    const getY = (val) => {
      const range = maxFlow - minFlow || 1;
      return svgH - pad.bottom - ((val - minFlow) / range) * (svgH - pad.top - pad.bottom);
    };

    const zeroY = getY(0);
    const barWidth = 24;

    const gridLines = [maxFlow, maxFlow / 2, 0, minFlow / 2, minFlow].map(val => ({ val, y: getY(val) }));

    return (
      <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3">
        <div className="flex justify-between items-center">
          <h4 className="text-xs font-bold text-slate-300 flex items-center gap-1.5 font-mono">
            <Users className="h-3.5 w-3.5 text-indigo-400" />
            NET CREATIONS / REDEMPTIONS (預估每日市場申贖流量)
          </h4>
          <span className="text-[10px] text-slate-500 font-mono">單位：新台幣億元</span>
        </div>

        <div className="relative w-full overflow-hidden">
          <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full h-auto overflow-visible">
            {gridLines.map((line, i) => (
              <g key={i}>
                <line x1={pad.left} y1={line.y} x2={svgW - pad.right} y2={line.y} stroke={line.val === 0 ? "#475569" : "#1e293b"} strokeWidth={line.val === 0 ? "1.5" : "1"} strokeDasharray={line.val === 0 ? "0" : "4 4"} />
                <text x={pad.left - 8} y={line.y + 3} fill={line.val === 0 ? "#94a3b8" : "#64748b"} fontSize="9" fontFamily="monospace" textAnchor="end">
                  {line.val > 0 ? '+' : ''}{line.val.toFixed(1)}
                </text>
              </g>
            ))}

            {chronologicalDays.map((d, idx) => {
              const x = getX(idx) - barWidth / 2;
              const val = d.estCashFlow100M;
              const isPositive = val >= 0;
              const y = isPositive ? getY(val) : zeroY;
              const barHeight = Math.max(Math.abs(getY(val) - zeroY), 3);

              const barColor = isPositive 
                ? (hoveredIdx === idx ? "#34d399" : "#10b981") 
                : (hoveredIdx === idx ? "#f87171" : "#ef4444");

              return (
                <g key={idx} onMouseEnter={() => setHoveredIdx(idx)} onMouseLeave={() => setHoveredIdx(null)} className="cursor-pointer">
                  <rect x={x} y={y} width={barWidth} height={barHeight} fill={barColor} rx="3" opacity={hoveredIdx !== null && hoveredIdx !== idx ? 0.5 : 1} />
                  <text x={getX(idx)} y={svgH - 8} fill={hoveredIdx === idx ? "#818cf8" : "#64748b"} fontSize="9" fontWeight={hoveredIdx === idx ? "bold" : "normal"} textAnchor="middle">
                    {d.date.substring(5)}
                  </text>
                </g>
              );
            })}
          </svg>

          {/* 懸浮明細視窗 */}
          {hoveredIdx !== null && (
            <div className="absolute top-1 right-1 bg-slate-900/95 border border-slate-800 p-2.5 rounded-lg shadow-lg text-[11px] space-y-1 pointer-events-none">
              <div className="font-bold text-slate-300 border-b border-slate-800 pb-1">{chronologicalDays[hoveredIdx].date}</div>
              <div className="flex justify-between gap-4 text-slate-400"><span>當日每股淨值:</span><span className="font-mono text-slate-200">{chronologicalDays[hoveredIdx].nav.toFixed(2)} 元</span></div>
              <div className="flex justify-between gap-4 text-slate-400"><span>流通受益單位:</span><span className="font-mono text-slate-200">{(chronologicalDays[hoveredIdx].units / 100000000).toFixed(4)} 億</span></div>
              <div className="flex justify-between gap-4 text-slate-400"><span>單位單日增減:</span><span className={`font-mono font-bold ${chronologicalDays[hoveredIdx].unitsChange100M > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{chronologicalDays[hoveredIdx].unitsChange100M > 0 ? '+' : ''}{chronologicalDays[hoveredIdx].unitsChange100M.toFixed(4)} 億</span></div>
              <div className="border-t border-slate-800 my-1 pt-1 flex justify-between gap-4 text-slate-300 font-semibold">
                <span>估計申購淨引資:</span>
                <span className={`font-mono ${chronologicalDays[hoveredIdx].estCashFlow100M > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {chronologicalDays[hoveredIdx].estCashFlow100M > 0 ? '+' : ''}{chronologicalDays[hoveredIdx].estCashFlow100M.toFixed(2)} 億元
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-indigo-500 selection:text-white pb-12">
      
      {/* 導航列 */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-4 flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="bg-gradient-to-tr from-indigo-500 to-cyan-500 p-2.5 rounded-xl shadow-lg shadow-indigo-500/15">
              <Activity className="h-6 w-6 text-white animate-pulse" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-white via-slate-100 to-indigo-300 bg-clip-text text-transparent">
                主動式 ETF 雲端即時動態儀表板
              </h1>
              <p className="text-xs text-slate-400">自動綁定 Google 試算表端點 · 前端邏輯解算</p>
            </div>
          </div>
          <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800">
            <button
              onClick={() => setActiveTab('cloud')}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${activeTab === 'cloud' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-200'}`}
            >
              <Link2 className="h-3.5 w-3.5" /> Google 試算表
            </button>
            <button
              onClick={() => setActiveTab('raw_paste')}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${activeTab === 'raw_paste' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-200'}`}
            >
              <FileText className="h-3.5 w-3.5" /> 手動貼上 CSV
            </button>
            <button
              onClick={() => setActiveTab('upload')}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${activeTab === 'upload' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-200'}`}
            >
              <HardDrive className="h-3.5 w-3.5" /> 本地上傳
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8 space-y-8">
        
        {/* ==================== 雲端數據與自訂輸入面板 ==================== */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">
          
          {activeTab === 'cloud' && (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-2">
                <h2 className="text-base font-bold flex items-center gap-2 text-white">
                  <Link2 className="h-5 w-5 text-indigo-400 animate-pulse" />
                  已串接 Google 試算表（即時更新監控中）
                </h2>
                <button 
                  onClick={() => setShowHowToPublish(!showHowToPublish)}
                  className="text-xs text-indigo-400 hover:text-indigo-300 underline flex items-center gap-1 self-start"
                >
                  如何確認我的 Google 試算表開啟共用權限？ {showHowToPublish ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
              </div>

              {showHowToPublish && (
                <div className="bg-indigo-950/20 border border-indigo-500/15 p-4 rounded-xl text-xs text-slate-300 space-y-2 leading-relaxed">
                  <p className="font-bold text-white text-sm">💡 確保跨域串接暢通的操作指引：</p>
                  <p>1. 在您的 Google 試算表中，點擊右上角的 <span className="text-emerald-400 font-bold">「共用」</span> 按鈕。</p>
                  <p>2. 在底下「一般存取權」中，將預設的「限制」切換為 <span className="text-indigo-400 font-bold">「知道連結的任何人」</span>（權限保持「檢視者」即可）。</p>
                  <p>3. 點選「複製連結」取得網址並貼在下方即可。本網頁會全自動在前端轉換格式、執行運算！</p>
                </div>
              )}

              <div className="flex flex-col lg:flex-row gap-4">
                <div className="relative flex-1">
                  <input
                    type="text"
                    value={driveUrl}
                    onChange={(e) => setDriveUrl(e.target.value)}
                    placeholder="請貼上您的 Google 試算表連結..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl py-3 pl-4 pr-12 text-xs text-slate-100 font-mono focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <button
                  onClick={() => fetchCsvFromDrive(driveUrl)}
                  disabled={syncStatus === 'loading'}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold py-3 px-6 rounded-xl flex items-center justify-center gap-2 disabled:opacity-50 transition-colors"
                >
                  <RefreshCw className={`h-4 w-4 ${syncStatus === 'loading' ? 'animate-spin' : ''}`} /> 同步連線
                </button>
              </div>
            </div>
          )}

          {activeTab === 'raw_paste' && (
            <div className="space-y-4">
              <h2 className="text-base font-bold flex items-center gap-2 text-white">
                <FileText className="h-5 w-5 text-indigo-400" />
                手動貼上 CSV 文字檔
              </h2>
              <div className="space-y-2">
                <textarea
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  placeholder="請在此貼上 CSV 數據... 第一行需為欄位標頭，例如: 資料日期,項目,數值,ETF類別"
                  className="w-full h-32 bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs font-mono text-slate-300 focus:border-indigo-500 focus:outline-none"
                />
                <div className="flex justify-end items-center">
                  <button
                    onClick={handleRawTextParse}
                    className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold py-2 px-5 rounded-lg transition-colors"
                  >
                    即時解析與計算
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'upload' && (
            <div className="space-y-4">
              <h2 className="text-base font-bold flex items-center gap-2 text-white">
                <HardDrive className="h-5 w-5 text-indigo-400" />
                本地 CSV 檔案拖放上傳
              </h2>
              <div className="border-2 border-dashed border-slate-700 rounded-xl p-6 text-center hover:border-indigo-500/50 transition-colors">
                <label className="flex flex-col items-center cursor-pointer">
                  <Upload className="h-8 w-8 text-slate-500 mb-2" />
                  <span className="text-xs font-bold text-indigo-400 bg-indigo-500/10 px-4 py-2 rounded-lg">選擇本地 CSV 檔案</span>
                  <input type="file" accept=".csv" onChange={handleFileUpload} className="hidden" />
                </label>
              </div>
            </div>
          )}

          {/* 連線與解析狀態回饋 */}
          {syncStatus === 'loading' && (
            <div className="p-3 bg-indigo-950/20 text-indigo-300 rounded-xl flex items-center gap-3 text-xs border border-indigo-500/20">
              <RefreshCw className="h-4 w-4 animate-spin flex-shrink-0" />
              正在嘗試跨域安全穿透並精算資料中...
            </div>
          )}

          {syncStatus === 'success' && (
            <div className="p-3 bg-emerald-950/20 text-emerald-400 rounded-xl flex items-center justify-between text-xs border border-emerald-500/20">
              <div className="flex items-center gap-3">
                <CheckCircle className="h-4 w-4 flex-shrink-0" />
                <span>🟢 成功！已成功連通試算表數據，即時執行公式精算中。</span>
              </div>
              <div className="flex items-center gap-2 bg-slate-950 px-3 py-1 rounded-lg border border-slate-800">
                <span className="text-[10px] text-slate-400">分析 ETF 代號：</span>
                <select
                  value={selectedEtf}
                  onChange={(e) => {
                    setSelectedEtf(e.target.value);
                    if (loadedData[e.target.value]?.[0]) setSelectedDayDetail(loadedData[e.target.value][0].date);
                  }}
                  className="bg-transparent text-xs font-bold text-indigo-400 focus:outline-none cursor-pointer"
                >
                  {Object.keys(loadedData).map(etf => <option key={etf} value={etf} className="bg-slate-900">{etf}</option>)}
                </select>
              </div>
            </div>
          )}

          {syncStatus === 'error' && (
            <div className="p-4 bg-rose-950/30 text-rose-400 rounded-xl border border-rose-500/20 space-y-3">
              <div className="flex items-start gap-3 text-xs">
                <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-bold">雲端同步連結遭遇限制或阻擋：</p>
                  <p className="text-[11px] text-slate-300 font-mono leading-relaxed">{errorMessage}</p>
                </div>
              </div>
              <div className="pl-8 flex flex-wrap gap-2">
                <button 
                  onClick={() => setActiveTab('raw_paste')}
                  className="text-[11px] bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 px-3 py-1.5 rounded-lg transition-colors font-semibold"
                >
                  👉 改用「手動貼上 CSV」
                </button>
                <button 
                  onClick={() => setShowHowToPublish(true)}
                  className="text-[11px] bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 px-3 py-1.5 rounded-lg transition-colors font-semibold"
                >
                  ⚙️ 查看設定共用指引
                </button>
              </div>
            </div>
          )}
        </section>

        {/* 只有在成功載入資料且有選定 ETF 時才顯示下方區塊 */}
        {syncStatus === 'success' && loadedData[selectedEtf] && loadedData[selectedEtf].length > 0 ? (
          <>
            {/* ==================== 首部資訊大卡 ==================== */}
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl relative overflow-hidden">
              <div className="absolute right-0 top-0 h-48 w-48 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full pointer-events-none" />
              
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold tracking-wider uppercase px-2.5 py-1 bg-indigo-500/10 text-indigo-400 rounded-full border border-indigo-500/20">
                      資產與籌碼即時運算
                    </span>
                    <span className="text-xs text-slate-400">
                      數據區間：{latestFiveDays[latestFiveDays.length - 1]?.date || 'N/A'} 至 {latestFiveDays[0]?.date || 'N/A'}
                    </span>
                  </div>
                  <h2 className="text-2xl font-bold text-white mt-2">
                    鎖定分析 ETF 代號：<span className="text-indigo-400 bg-indigo-950 px-3 py-1 rounded-xl border border-indigo-500/20 ml-1">{selectedEtf}</span>
                  </h2>
                </div>
                
                <div className="flex flex-col gap-1 w-full md:w-auto">
                  <label className="text-xs text-slate-400 font-semibold">基準日期切換：</label>
                  <select
                    value={selectedDayDetail}
                    onChange={(e) => setSelectedDayDetail(e.target.value)}
                    className="bg-slate-950 border border-slate-800 text-sm font-semibold text-white px-4 py-2.5 rounded-xl focus:border-indigo-500 outline-none cursor-pointer"
                  >
                    {latestFiveDays.map(d => <option key={d.date} value={d.date}>{d.date}</option>)}
                  </select>
                </div>
              </div>

              {/* 基準日關鍵指標大字報 */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-6">
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800/80">
                  <span className="text-xs text-slate-400 font-medium">總淨資產規模</span>
                  <p className="text-xl font-black text-white mt-1">
                    {selectedDayData ? (selectedDayData.netAsset / 100000000).toFixed(2) : '--'} <span className="text-xs text-slate-400">億元</span>
                  </p>
                </div>
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800/80">
                  <span className="text-xs text-slate-400 font-medium">每單位淨值 (NAV)</span>
                  <p className="text-xl font-black text-indigo-400 mt-1">
                    {selectedDayData ? selectedDayData.nav.toFixed(2) : '--'} <span className="text-xs text-slate-400">元</span>
                  </p>
                </div>
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800/80">
                  <span className="text-xs text-slate-400 font-medium">流通在外單位</span>
                  <p className="text-xl font-black text-white mt-1">
                    {selectedDayData ? (selectedDayData.units / 100000000).toFixed(4) : '--'} <span className="text-xs text-slate-400">億個</span>
                  </p>
                </div>
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800/80">
                  <span className="text-xs text-slate-400 font-medium">實際可用賸餘銀彈</span>
                  <p className="text-xl font-black text-cyan-400 mt-1">
                    {selectedDayData ? selectedDayData.actualCash100M.toFixed(4) : '--'} <span className="text-xs text-slate-400">億元</span>
                  </p>
                </div>
              </div>
            </section>

            {/* ==================== 1. 資金動態表 ==================== */}
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div className="flex items-center gap-3">
                  <div className="bg-cyan-500/10 p-2.5 rounded-xl border border-cyan-500/20">
                    <DollarSign className="h-5 w-5 text-cyan-400" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-white">一、資金動態表：經理人手上還有多少錢？</h3>
                    <p className="text-xs text-slate-400">實際剩餘現金 = 現金 + 應收付證券款 + 申贖應付款</p>
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto animate-fadeIn">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 text-xs uppercase font-semibold">
                      <th className="py-3 px-4">交易日期</th>
                      <th className="py-3 px-4 text-right">實際剩餘現金 (億元)</th>
                      <th className="py-3 px-4 text-right">現金佔比 (%)</th>
                      <th className="py-3 px-4 text-right">每日增減量 (億元)</th>
                      <th className="py-3 px-4 text-center">操盤手戰術判定</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-sm">
                    {latestFiveDays.map((d) => {
                      const isSelected = selectedDayDetail === d.date;
                      return (
                        <tr key={d.date} onClick={() => setSelectedDayDetail(d.date)} className={`hover:bg-slate-800/30 cursor-pointer transition-colors ${isSelected ? 'bg-indigo-600/10 border-l-4 border-indigo-500' : ''}`}>
                          <td className="py-3.5 px-4 font-semibold text-slate-300">{d.date}</td>
                          <td className="py-3.5 px-4 text-right font-mono text-cyan-400 font-bold">{d.actualCash100M.toFixed(4)}</td>
                          <td className="py-3.5 px-4 text-right font-mono text-slate-300">{d.cashRatio.toFixed(3)}%</td>
                          <td className="py-3.5 px-4 text-right font-mono">
                            <span className={d.cashChange > 0 ? 'text-emerald-400 font-bold' : d.cashChange < 0 ? 'text-rose-400 font-bold' : 'text-slate-500'}>
                              {d.cashChange > 0 ? '+' : ''}{d.cashChange.toFixed(3)}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-center">
                            <span className={`text-xs px-2.5 py-1 rounded-full font-bold ${d.receivable < 0 && Math.abs(d.receivable) > d.cash ? 'bg-rose-500/15 text-rose-400 border border-rose-500/25' : d.cashChange < 0 ? 'bg-rose-500/15 text-rose-400 border border-rose-500/25' : 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/25'}`}>
                               {d.receivable < 0 && Math.abs(d.receivable) > d.cash ? '預支攻堅 ⚡' : d.cashChange < 0 ? '領錢進攻 🔥' : '存錢防禦 🛡️'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* 資金水位趨勢圖 */}
              <ChronologicalCashChart />

              {selectedDayData && (
                <div className="bg-slate-950 rounded-xl p-5 border border-slate-800 space-y-4">
                  <h4 className="text-sm font-bold text-white flex items-center gap-2 border-b border-slate-800 pb-2">
                    <Info className="h-4 w-4 text-indigo-400" /> 【即時運算明細表】基準日：{selectedDayData.date}
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm mb-2">
                    <div className="p-3 bg-slate-900 rounded-lg"><span className="text-xs text-slate-500">1. 帳面現金</span><br/><span className="font-mono text-white font-bold">{selectedDayData.cash.toLocaleString()}</span></div>
                    <div className="p-3 bg-slate-900 rounded-lg"><span className="text-xs text-slate-500">2. 應收付證券款(+)</span><br/><span className={`font-mono font-bold ${selectedDayData.receivable < 0 ? 'text-rose-400' : 'text-slate-300'}`}>{selectedDayData.receivable.toLocaleString()}</span></div>
                    <div className="p-3 bg-slate-900 rounded-lg"><span className="text-xs text-slate-500">3. 申贖應付款(+)</span><br/><span className={`font-mono font-bold ${selectedDayData.redemption < 0 ? 'text-rose-400' : 'text-slate-300'}`}>{selectedDayData.redemption.toLocaleString()}</span></div>
                    <div className="p-3 bg-slate-900 rounded-lg border border-indigo-500/30"><span className="text-xs text-indigo-400 font-bold">4. 實際可用賸餘銀彈</span><br/><span className="font-mono text-cyan-400 font-black">{selectedDayData.rawActualCash.toLocaleString()} 元</span></div>
                  </div>
                  <div className={`p-4 rounded-xl border ${cashTacticsInterpretation(selectedDayData).color}`}>
                    <h5 className="font-bold text-sm mb-1">{cashTacticsInterpretation(selectedDayData).title}</h5>
                    <p className="text-xs leading-relaxed">{cashTacticsInterpretation(selectedDayData).text}</p>
                  </div>
                </div>
              )}
            </section>

            {/* ==================== 2. 市場買氣表 ==================== */}
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div className="flex items-center gap-3">
                  <div className="bg-indigo-500/10 p-2.5 rounded-xl border border-indigo-500/20">
                    <Users className="h-5 w-5 text-indigo-400" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-white">二、市場買氣表：投資人搶購熱度（含比例）</h3>
                    <p className="text-xs text-slate-400">預估申贖引發的現金流量 = 流通單位數增減(個) * 當日淨值</p>
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 text-xs uppercase font-semibold">
                      <th className="py-3 px-4">交易日期</th>
                      <th className="py-3 px-4 text-right">每單位淨值 (元)</th>
                      <th className="py-3 px-4 text-right">流通單位數 (億單位)</th>
                      <th className="py-3 px-4 text-right">增減量 (億單位)</th>
                      <th className="py-3 px-4 text-right">增減比例 (%)</th>
                      <th className="py-3 px-4 text-right">預估現金增減量 (億元)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-sm">
                    {latestFiveDays.map((d) => (
                      <tr key={d.date} className="hover:bg-slate-800/15 transition-all">
                        <td className="py-3.5 px-4 font-semibold text-slate-300">{d.date}</td>
                        <td className="py-3.5 px-4 text-right font-mono text-indigo-300">{d.nav.toFixed(2)}</td>
                        <td className="py-3.5 px-4 text-right font-mono">{(d.units / 100000000).toFixed(4)}</td>
                        <td className="py-3.5 px-4 text-right font-mono">
                           <span className={d.unitsChange100M > 0 ? 'text-emerald-400 font-bold' : d.unitsChange100M < 0 ? 'text-rose-400 font-bold' : 'text-slate-500'}>
                            {d.unitsChange100M > 0 ? '+' : ''}{d.unitsChange100M.toFixed(4)}
                           </span>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono">
                           <span className={d.unitsChangeRatio > 0 ? 'text-emerald-400' : d.unitsChangeRatio < 0 ? 'text-rose-400' : 'text-slate-500'}>
                            {d.unitsChangeRatio > 0 ? '+' : ''}{d.unitsChangeRatio.toFixed(3)}%
                           </span>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-white font-bold">
                          <span className={d.estCashFlow100M > 0 ? 'text-emerald-400' : d.estCashFlow100M < 0 ? 'text-rose-400' : ''}>
                            {d.estCashFlow100M > 0 ? '+' : ''}{d.estCashFlow100M.toFixed(2)} 億
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* 市場買氣淨申贖圖 */}
              <ChronologicalSentimentChart />

              {selectedDayData && (
                <div className="bg-indigo-500/5 rounded-xl p-4 border border-indigo-500/10">
                  <span className="text-xs text-indigo-400 font-bold block mb-1">大眾追價與市場熱度白話解讀 ({selectedDayData.date})</span>
                  <div className="text-sm font-bold text-indigo-300 mb-1">{marketSentimentInterpretation(selectedDayData).trend}</div>
                  <p className="text-xs text-slate-300 leading-relaxed">{marketSentimentInterpretation(selectedDayData).text}</p>
                </div>
              )}
            </section>

            {/* ==================== 3. 重要持股變化 ==================== */}
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div className="flex items-center gap-3">
                  <div className="bg-indigo-500/10 p-2.5 rounded-xl border border-indigo-500/20">
                    <Layers className="h-5 w-5 text-indigo-400" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-white">三、重要持股變化（產業類別追蹤）</h3>
                    <p className="text-xs text-slate-400">追蹤主動型操盤手在基金擴張期間的核心個股與產業配置動態</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                
                {/* 大幅加碼組 */}
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-5 space-y-3">
                  <h4 className="text-emerald-400 font-bold flex items-center gap-2 border-b border-slate-850 pb-2">
                    <TrendingUp className="h-4 w-4" /> 【大幅加碼】主力攻擊箭頭
                  </h4>
                  <div className="text-xs text-slate-500 text-center py-6">請等待匯入持股明細檔案以顯示資料...</div>
                </div>

                {/* 大幅減碼/清倉組 */}
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-5 space-y-3">
                  <h4 className="text-rose-400 font-bold flex items-center gap-2 border-b border-slate-850 pb-2">
                    <TrendingDown className="h-4 w-4" /> 【大幅減碼/清倉】非核心汰弱
                  </h4>
                  <div className="text-xs text-slate-500 text-center py-6">請等待匯入持股明細檔案以顯示資料...</div>
                </div>

                {/* 新建倉組 */}
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-5 space-y-3">
                  <h4 className="text-cyan-400 font-bold flex items-center gap-2 border-b border-slate-850 pb-2">
                    <Activity className="h-4 w-4" /> 【新建倉】巨型防禦地基
                  </h4>
                  <div className="text-xs text-slate-500 text-center py-6">請等待匯入持股明細檔案以顯示資料...</div>
                </div>
              </div>
            </section>
          </>
        ) : (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-12 text-center shadow-xl space-y-4">
            <Activity className="h-12 w-12 text-slate-600 mx-auto" />
            <h3 className="text-lg font-bold text-slate-400">目前尚無分析數據</h3>
            <p className="text-sm text-slate-500">
              請從上方選擇「Google 試算表連線」、「手動貼上 CSV」或「本地上傳」，以載入最新的資產籌碼數據進行即時運算。
            </p>
          </div>
        )}

      </main>

      <footer className="border-t border-slate-800 bg-slate-950 py-8 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 space-y-2">
          <p>© 2026 ETF 智慧籌碼監控中心 · 本網頁完美對接指定之 Google Sheets 共用試算表進行即時差額與趨勢運算</p>
          <p className="text-slate-600">
            請注意：本儀表板所有計算、圖表與解讀結果僅供投資參考，不構成任何形式的投資邀約或理財推薦。投資人應謹慎自行評估風險。
          </p>
        </div>
      </footer>

    </div>
  );
}