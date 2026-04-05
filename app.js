// ---------- DATABASE & INIT ----------
const db = new Dexie('CricketArenaDB');
db.version(1).stores({
    teams: '++id, name, shortName',
    players: '++id, teamId, name, role, battingOrder',
    tournaments: '++id, name, createdAt, active',
    matches: '++id, tournamentId, teamAId, teamBId, matchType, round, status, winnerId, date, inningsData, isPlayoff',
    playerStats: '++id, tournamentId, playerId, runs, balls, wickets, runsConceded, oversBowled, innings, highestScore, bestWickets'
});

const TEAMS_DATA = [
    { name: "Chennai Super Kings", short: "CSK", players: ["V. Kohli","M. Agarwal","R. Pant","S. Dube","R. Parag","W. Sundar","N. Rana","R. Ashwin","M. Shami","Y. Chahal","T. Natarajan"] },
    { name: "Mumbai Indians", short: "MI", players: ["S. Dhawan","S. Iyer","S. Samson","H. Pandya","D. Hooda","K. Pandya","A. Patel","B. Kumar","V. Chakravarthy","R. Bishnoi","M. Siraj"] },
    { name: "Kolkata Knight Riders", short: "KKR", players: ["Y. Jaiswal","L. Rahul","R. Jadeja","M. Pandey","V. Iyer","R. Tewatia","H. Patel","S. Thakur","U. Malik","K. Yadav","J. Bumrah"] },
    { name: "Delhi Capitals", short: "DC", players: ["R. Sharma","S. Gill","A. Sharma","P. Shaw","D. Karthik","N. Reddy","J. Yadav","D. Chahar","T. Deshpande","M. Yadav","R. Kishore"] },
    { name: "Rajasthan Royals", short: "RR", players: ["I. Kishan","S. Yadav","T. Varma","R. Singh","D. Jurel","D. Padikkal","S. Mavi","P. Krishna","R. Chahar","U. Yadav","N. Saini"] },
    { name: "Punjab Kings", short: "PBKS", players: ["R. Gaikwad","S. Sudharsan","J. Sharma","R. Tripathi","R. Singh","K. Gowtham","A. Khan","H. Rana","M. Kumar","K. Ahmed","A. Singh"] }
];

let currentTournamentId = null;

async function initDB() {
    await db.open();
    const teamCount = await db.teams.count();
    if(teamCount === 0) {
        for(let idx=0; idx<TEAMS_DATA.length; idx++) {
            let t = TEAMS_DATA[idx];
            let teamId = await db.teams.add({ name: t.name, shortName: t.short });
            for(let i=0; i<t.players.length; i++) {
                await db.players.add({ teamId, name: t.players[i], role: i<2?"Batter":(i>7?"Bowler":"All-rounder"), battingOrder: i+1 });
            }
        }
    }
    const tourneys = await db.tournaments.toArray();
    if(tourneys.length === 0) {
        await db.tournaments.add({ name: "Champions Trophy 2025", createdAt: new Date(), active: true });
    }
    await loadTournaments();
}

async function loadTournaments() {
    let tours = await db.tournaments.orderBy('createdAt').reverse().toArray();
    let select = document.getElementById('tournamentSelect');
    select.innerHTML = '';
    tours.forEach(t => {
        let opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `${t.name} ${t.active ? '✓' : ''}`;
        if(t.active) currentTournamentId = t.id;
        select.appendChild(opt);
    });
    if(currentTournamentId) select.value = currentTournamentId;
    else if(tours.length) currentTournamentId = tours[0].id;
    await switchTournament();
}

async function switchTournament() {
    currentTournamentId = parseInt(document.getElementById('tournamentSelect').value);
    await refreshAllPanels();
}

// ---------- DOUBLE ROUND ROBIN (30 matches) ----------
const SCHEDULE_FIXTURES = [
    ["CSK","MI"],["KKR","PBKS"],["DC","RR"],["CSK","KKR"],["MI","DC"],["RR","PBKS"],
    ["CSK","DC"],["MI","RR"],["KKR","PBKS"],["CSK","RR"],["MI","PBKS"],["KKR","DC"],
    ["CSK","PBKS"],["MI","KKR"],["DC","RR"],["CSK","MI"],["KKR","PBKS"],["DC","RR"],
    ["CSK","KKR"],["MI","DC"],["RR","PBKS"],["CSK","DC"],["MI","RR"],["KKR","PBKS"],
    ["CSK","RR"],["MI","PBKS"],["KKR","DC"],["CSK","PBKS"],["MI","KKR"],["DC","RR"]
];

async function generateLeagueMatches() {
    if(!currentTournamentId) return Swal.fire("Select tournament");
    const existing = await db.matches.where({ tournamentId: currentTournamentId, isPlayoff: 0 }).count();
    if(existing > 0) {
        let confirm = await Swal.fire({title: "League matches exist", text: "Replace existing league matches? This will delete previous league matches.", showCancelButton:true});
        if(!confirm.isConfirmed) return;
        await db.matches.where({ tournamentId: currentTournamentId, isPlayoff: 0 }).delete();
    }
    let teamsMap = new Map();
    let allTeams = await db.teams.toArray();
    allTeams.forEach(t => { teamsMap.set(t.shortName, t.id); });
    for(let fix of SCHEDULE_FIXTURES) {
        let teamAId = teamsMap.get(fix[0]);
        let teamBId = teamsMap.get(fix[1]);
        if(teamAId && teamBId) {
            await db.matches.add({ tournamentId: currentTournamentId, teamAId, teamBId, matchType: "league", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 0 });
        }
    }
    Swal.fire("Generated 30 league matches!");
    await refreshAllPanels();
}

async function generatePlayoffs() {
    if(!currentTournamentId) return;
    const standings = await computeStandings();
    if(standings.length < 4) { Swal.fire("Need at least 4 teams with points"); return; }
    let top4 = standings.slice(0,4).map(s => s.teamId);
    let [first, second, third, fourth] = top4;
    await db.matches.where({ tournamentId: currentTournamentId, isPlayoff: 1 }).delete();
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: first, teamBId: second, matchType: "Qualifier 1", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1 });
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: third, teamBId: fourth, matchType: "Eliminator", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1 });
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: null, teamBId: null, matchType: "Qualifier 2", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1 });
    await db.matches.add({ tournamentId: currentTournamentId, teamAId: null, teamBId: null, matchType: "Final", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff: 1 });
    Swal.fire("Playoff slots created (Qualifier1, Eliminator, Qualifier2, Final). Enter results manually.");
    await refreshAllPanels();
}

// ---------- STANDINGS & POINTS ----------
async function computeStandings() {
    let matches = await db.matches.where({ tournamentId: currentTournamentId, isPlayoff: 0 }).toArray();
    let teams = await db.teams.toArray();
    let pointsMap = new Map();
    teams.forEach(t => pointsMap.set(t.id, { teamId: t.id, name: t.name, played:0, won:0, lost:0, tied:0, points:0, nrr:0, runsFor:0, oversFor:0, runsAgainst:0, oversAgainst:0 }));
    for(let m of matches) {
        if(m.status !== "completed" || !m.winnerId) continue;
        let teamA = m.teamAId, teamB = m.teamBId, winner = m.winnerId;
        let statsA = pointsMap.get(teamA), statsB = pointsMap.get(teamB);
        if(statsA && statsB) {
            statsA.played++; statsB.played++;
            if(winner === teamA) { statsA.won++; statsB.lost++; statsA.points+=2; }
            else if(winner === teamB) { statsB.won++; statsA.lost++; statsB.points+=2; }
            else { statsA.tied++; statsB.tied++; statsA.points+=1; statsB.points+=1; }
            if(m.inningsData) {
                let inn = m.inningsData;
                if(inn.teamARuns && inn.teamAOver) { statsA.runsFor += inn.teamARuns; statsA.oversFor += inn.teamAOver; statsB.runsAgainst += inn.teamARuns; statsB.oversAgainst += inn.teamAOver; }
                if(inn.teamBRuns && inn.teamBOver) { statsB.runsFor += inn.teamBRuns; statsB.oversFor += inn.teamBOver; statsA.runsAgainst += inn.teamBRuns; statsA.oversAgainst += inn.teamBOver; }
            }
        }
    }
    let standingsArr = Array.from(pointsMap.values());
    for(let s of standingsArr) {
        s.nrr = ((s.runsFor/(s.oversFor||1)) - (s.runsAgainst/(s.oversAgainst||1))).toFixed(2);
    }
    standingsArr.sort((a,b)=> b.points - a.points || parseFloat(b.nrr) - parseFloat(a.nrr));
    return standingsArr;
}

async function renderPointsTable() {
    let standings = await computeStandings();
    let html = `<table class="stat-table"><thead><tr><th>Team</th><th>Pld</th><th>W</th><th>L</th><th>Pts</th><th>NRR</th></tr></thead><tbody>`;
    standings.forEach(s=>{
        html += `<tr><td>${s.name}</td><td>${s.played}</td><td>${s.won}</td><td>${s.lost}</td><td><b>${s.points}</b></td><td>${s.nrr}</td></tr>`;
    });
    html+=`</tbody></table>`;
    document.getElementById('pointsTable').innerHTML = html;
}

// ---------- PLAYER STATS & CAPS ----------
async function computePlayerStats() {
    let stats = await db.playerStats.where({ tournamentId: currentTournamentId }).toArray();
    let players = await db.players.toArray();
    let playerMap = new Map(players.map(p=>[p.id, p]));
    let runsArr = stats.filter(s=>s.runs>0).sort((a,b)=>b.runs - a.runs);
    let wicketsArr = stats.filter(s=>s.wickets>0).sort((a,b)=>b.wickets - a.wickets);
    let topRuns = runsArr.slice(0,5);
    let topWkts = wicketsArr.slice(0,5);
    let runsHtml = topRuns.map(s=>{ let pl = playerMap.get(s.playerId); let sr = s.balls ? ((s.runs/s.balls)*100).toFixed(1) : 0; return `<div class="player-row"><span>${pl?.name||"?"}</span><span><b>${s.runs}</b> runs | SR ${sr}</span></div>`; }).join('');
    let wktHtml = topWkts.map(s=>{ let pl = playerMap.get(s.playerId); let avg = s.wickets ? (s.runsConceded/s.wickets).toFixed(1) : '-'; return `<div class="player-row"><span>${pl?.name||"?"}</span><span><b>${s.wickets}</b> wkts | Avg ${avg}</span></div>`; }).join('');
    document.getElementById('topRunsList').innerHTML = runsHtml || "<div>No data</div>";
    document.getElementById('topWicketsList').innerHTML = wktHtml || "<div>No data</div>";
    let orange = runsArr[0]; let purple = wicketsArr[0];
    document.getElementById('orangeCapName').innerText = orange ? (playerMap.get(orange.playerId)?.name||'--') : '--';
    document.getElementById('orangeCapRuns').innerText = orange ? `${orange.runs} runs` : '';
    document.getElementById('purpleCapName').innerText = purple ? (playerMap.get(purple.playerId)?.name||'--') : '--';
    document.getElementById('purpleCapWkts').innerText = purple ? `${purple.wickets} wickets` : '';
}

async function updateTournamentStats(tournamentId, performanceArray) {
    for(let perf of performanceArray) {
        let existing = await db.playerStats.where({ tournamentId, playerId: perf.playerId }).first();
        if(!existing) existing = { tournamentId, playerId: perf.playerId, runs:0, balls:0, wickets:0, runsConceded:0, oversBowled:0, highestScore:0, bestWickets:0 };
        if(perf.type === 'bat') {
            existing.runs += perf.runs;
            existing.balls += perf.balls;
            if(perf.runs > existing.highestScore) existing.highestScore = perf.runs;
        }
        if(perf.type === 'bowl') {
            existing.wickets += perf.wickets;
            existing.runsConceded += perf.runsConc;
            existing.oversBowled += perf.overs;
            if(perf.wickets > existing.bestWickets) existing.bestWickets = perf.wickets;
        }
        await db.playerStats.put(existing);
    }
}

// ---------- MATCH UI & SCORECARD ----------
async function renderMatchesList() {
    let matches = await db.matches.where({ tournamentId: currentTournamentId }).reverse().sortBy('id');
    let teams = await db.teams.toArray();
    let teamDict = Object.fromEntries(teams.map(t=>[t.id, t]));
    let container = document.getElementById('matchesListContainer');
    if(!matches.length) { container.innerHTML = "<div class='card'>No matches. Generate league or create custom match.</div>"; return; }
    let html = '';
    for(let m of matches) {
        let teamAName = teamDict[m.teamAId]?.name || 'TBD';
        let teamBName = teamDict[m.teamBId]?.name || 'TBD';
        let statusBadge = m.status === 'completed' ? `✅ ${teamDict[m.winnerId]?.name || 'winner'}` : (m.status==='pending' ? '⏳ Pending' : 'In Progress');
        html += `<div class="match-item" onclick="openScorecardForMatch(${m.id})">
                    <div style="display:flex; justify-content:space-between;"><strong>${teamAName} vs ${teamBName}</strong> <span class="badge">${m.matchType || 'League'}</span></div>
                    <div>${statusBadge}</div>
                    <div style="font-size:12px;">${m.date?.slice(0,10) || ''}</div>
                </div>`;
    }
    container.innerHTML = html;
}

async function openScorecardForMatch(matchId) {
    let match = await db.matches.get(matchId);
    if(!match) return;
    document.getElementById('currentMatchId').value = matchId;
    document.getElementById('modalMatchTitle').innerHTML = `Enter Scorecard: ${(await db.teams.get(match.teamAId))?.name} vs ${(await db.teams.get(match.teamBId))?.name}`;
    let teamA = await db.teams.get(match.teamAId);
    let teamB = await db.teams.get(match.teamBId);
    let playersA = await db.players.where('teamId').equals(match.teamAId).toArray();
    let playersB = await db.players.where('teamId').equals(match.teamBId).toArray();
    let container = document.getElementById('inningsContainer');
    container.innerHTML = `
        <div class="innings-block"><h4>🏏 ${teamA.name} Batting</h4>
        ${playersA.map(p => `<div style="display:flex; gap:8px; margin-bottom:6px;"><span style="width:120px;">${p.name}</span><input type="number" placeholder="Runs" class="runs_a_${p.id}" style="width:70px;"><input type="number" placeholder="Balls" class="balls_a_${p.id}" style="width:70px;"></div>`).join('')}
        <h4>🎯 Bowling (${teamB.name})</h4>
        ${playersB.map(p => `<div><span>${p.name}</span> <input type="number" placeholder="Overs" class="overs_b_${p.id}" step="0.1" style="width:70px;"> <input type="number" placeholder="Runs" class="runsConc_b_${p.id}" style="width:70px;"> <input type="number" placeholder="Wickets" class="wickets_b_${p.id}" style="width:70px;"></div>`).join('')}
        <div><label>Extras</label><input type="number" id="extrasA" value="0"></div>
        </div>
        <div class="innings-block"><h4>🏏 ${teamB.name} Batting</h4>
        ${playersB.map(p => `<div style="display:flex; gap:8px;"><span style="width:120px;">${p.name}</span><input type="number" placeholder="Runs" class="runs_b_${p.id}" style="width:70px;"><input type="number" placeholder="Balls" class="balls_b_${p.id}" style="width:70px;"></div>`).join('')}
        <h4>🎯 Bowling (${teamA.name})</h4>
        ${playersA.map(p => `<div><span>${p.name}</span> <input type="number" placeholder="Overs" class="overs_a_${p.id}" step="0.1" style="width:70px;"> <input type="number" placeholder="Runs" class="runsConc_a_${p.id}" style="width:70px;"> <input type="number" placeholder="Wickets" class="wickets_a_${p.id}" style="width:70px;"></div>`).join('')}
        <div><label>Extras</label><input type="number" id="extrasB" value="0"></div>
        </div>`;
    document.getElementById('scorecardModal').classList.add('active');
}

window.closeScorecardModal = () => document.getElementById('scorecardModal').classList.remove('active');

document.getElementById('scorecardForm').onsubmit = async (e) => {
    e.preventDefault();
    let matchId = parseInt(document.getElementById('currentMatchId').value);
    let match = await db.matches.get(matchId);
    if(!match) return;
    let teamA = match.teamAId, teamB = match.teamBId;
    let playersA = await db.players.where('teamId').equals(teamA).toArray();
    let playersB = await db.players.where('teamId').equals(teamB).toArray();
    let inningsData = { teamARuns:0, teamAOver:0, teamBRuns:0, teamBOver:0 };
    let totalRunsA = 0, totalRunsB = 0;
    let statsUpdates = [];

    // Inning A batting
    for(let p of playersA) {
        let runs = parseInt(document.querySelector(`.runs_a_${p.id}`)?.value) || 0;
        let balls = parseInt(document.querySelector(`.balls_a_${p.id}`)?.value) || 0;
        totalRunsA += runs;
        statsUpdates.push({ playerId: p.id, runs, balls, type: 'bat' });
    }
    for(let p of playersB) {
        let wickets = parseInt(document.querySelector(`.wickets_b_${p.id}`)?.value) || 0;
        let runsConc = parseInt(document.querySelector(`.runsConc_b_${p.id}`)?.value) || 0;
        let overs = parseFloat(document.querySelector(`.overs_b_${p.id}`)?.value) || 0;
        statsUpdates.push({ playerId: p.id, wickets, runsConc, overs, type: 'bowl' });
        inningsData.teamAOver += overs;
    }
    let extrasA = parseInt(document.getElementById('extrasA')?.value) || 0;
    totalRunsA += extrasA;
    inningsData.teamARuns = totalRunsA;

    // Inning B batting
    for(let p of playersB) {
        let runs = parseInt(document.querySelector(`.runs_b_${p.id}`)?.value) || 0;
        let balls = parseInt(document.querySelector(`.balls_b_${p.id}`)?.value) || 0;
        totalRunsB += runs;
        statsUpdates.push({ playerId: p.id, runs, balls, type: 'bat' });
    }
    for(let p of playersA) {
        let wickets = parseInt(document.querySelector(`.wickets_a_${p.id}`)?.value) || 0;
        let runsConc = parseInt(document.querySelector(`.runsConc_a_${p.id}`)?.value) || 0;
        let overs = parseFloat(document.querySelector(`.overs_a_${p.id}`)?.value) || 0;
        statsUpdates.push({ playerId: p.id, wickets, runsConc, overs, type: 'bowl' });
        inningsData.teamBOver += overs;
    }
    let extrasB = parseInt(document.getElementById('extrasB')?.value) || 0;
    totalRunsB += extrasB;
    inningsData.teamBRuns = totalRunsB;

    let winnerId = totalRunsA > totalRunsB ? teamA : (totalRunsB > totalRunsA ? teamB : null);
    match.status = "completed";
    match.winnerId = winnerId;
    match.inningsData = inningsData;
    await db.matches.update(matchId, match);
    await updateTournamentStats(currentTournamentId, statsUpdates);
    Swal.fire("Match saved & stats updated!");
    closeScorecardModal();
    await refreshAllPanels();
};

// ---------- REFRESH ALL ----------
async function refreshAllPanels() {
    if(!currentTournamentId) return;
    await renderMatchesList();
    await computePlayerStats();
    await renderPointsTable();
}

// ---------- EVENT LISTENERS ----------
document.getElementById('tournamentSelect').addEventListener('change', switchTournament);
document.getElementById('newTournamentBtn').onclick = async () => {
    let { value: name } = await Swal.fire({ title: "Tournament name", input: 'text', inputValue: `Tournament ${new Date().getFullYear()}` });
    if(name) {
        await db.tournaments.add({ name, createdAt: new Date(), active: true });
        await loadTournaments();
    }
};
document.getElementById('genLeagueBtn').onclick = generateLeagueMatches;
document.getElementById('genPlayoffsBtn').onclick = generatePlayoffs;
document.getElementById('createCustomMatchBtn').onclick = async () => {
    let teams = await db.teams.toArray();
    let teamOpts = teams.map(t=>`<option value="${t.id}">${t.name}</option>`).join('');
    let { value: ids } = await Swal.fire({ title: "Create Custom Match", html: `<select id="teamA">${teamOpts}</select> vs <select id="teamB">${teamOpts}</select>`, preConfirm:()=>{ return { teamA: document.getElementById('teamA').value, teamB: document.getElementById('teamB').value }; } });
    if(ids) {
        await db.matches.add({ tournamentId: currentTournamentId, teamAId: parseInt(ids.teamA), teamBId: parseInt(ids.teamB), matchType: "custom", status: "pending", winnerId: null, date: new Date().toISOString(), inningsData: null, isPlayoff:0 });
        await refreshAllPanels();
        Swal.fire("Custom match added!");
    }
};

// TABS
document.querySelectorAll('.tab').forEach(tab=>{
    tab.addEventListener('click',()=>{
        document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
        tab.classList.add('active');
        let target = tab.getAttribute('data-tab');
        document.getElementById('dashboardPanel').classList.add('hidden-panel');
        document.getElementById('matchesPanel').classList.add('hidden-panel');
        document.getElementById('standingsPanel').classList.add('hidden-panel');
        document.getElementById('schedulePanel').classList.add('hidden-panel');
        if(target === 'dashboard') document.getElementById('dashboardPanel').classList.remove('hidden-panel');
        if(target === 'matches') document.getElementById('matchesPanel').classList.remove('hidden-panel');
        if(target === 'standings') document.getElementById('standingsPanel').classList.remove('hidden-panel');
        if(target === 'schedule') document.getElementById('schedulePanel').classList.remove('hidden-panel');
    });
});

initDB().then(()=>refreshAllPanels());