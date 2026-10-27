//! What an account may use: its plan and credit balance, and the model catalog.
//!
//! Both come from the same places the CLI uses (command-code 1.87):
//! * `GET /alpha/whoami`, `/alpha/billing/subscriptions`, `/alpha/billing/credits`
//!   on api.commandcode.ai, with the account's key (the CLI's `createBilling`);
//! * the model catalog the CLI caches under `~/.commandcode/cache/model-catalog`,
//!   where every model carries its `minimumPlan` and pricing.
//!
//! The access rules themselves live in the frontend (`src/billing.ts`).

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::Value;

use crate::accounts::request_key;

const API: &str = "https://api.commandcode.ai";
/// Subscription states the CLI treats as "has this plan".
const ACTIVE: [&str; 3] = ["active", "trialing", "past_due"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Billing {
    pub user_name: Option<String>,
    /// Plan id when the subscription is active (`individual-go-v1`, ...).
    pub plan_id: Option<String>,
    pub plan_status: Option<String>,
    pub monthly_credits: f64,
    pub purchased_credits: f64,
    pub free_credits: f64,
    /// When the current billing period ends (ISO 8601), for "renews in N days".
    pub period_end: Option<String>,
    /// Rolling-window limits (`{limited, fiveHour: {used, cap, resetAt}, weekly}`,
    /// `resetAt` in epoch ms) as the API sends them, beside `credits` in the
    /// credits response; present only while a plan has window limits.
    pub window_limits: Option<Value>,
}

fn get(agent: &ureq::Agent, key: &str, route: &str) -> Result<Value, String> {
    let response = agent
        .get(&format!("{API}{route}"))
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {key}"))
        .call();
    match response {
        Ok(r) => r.into_json::<Value>().map_err(|e| format!("{route}: {e}")),
        Err(ureq::Error::Status(401, _)) => Err("이 계정의 로그인 정보가 유효하지 않습니다.".into()),
        Err(ureq::Error::Status(code, _)) => Err(format!("{route}: HTTP {code}")),
        Err(e) => Err(format!("{route}: {e}")),
    }
}

fn with_org(route: &str, org: Option<&str>) -> String {
    match org {
        Some(id) => format!("{route}?orgId={}", urlencoding(id)),
        None => route.to_string(),
    }
}

fn urlencoding(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0).max(0.0)
}

/// Plan and credits for an account (`None`: the CLI login).
#[tauri::command]
pub async fn account_billing(account_id: Option<String>) -> Result<Billing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = request_key(account_id.as_deref())?.ok_or("로그인되어 있지 않습니다.")?;
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(12)).build();

        let who = get(&agent, &key, "/alpha/whoami")?;
        let org = who.pointer("/org/id").and_then(Value::as_str).map(str::to_string);
        let user_name = who
            .pointer("/user/userName")
            .and_then(Value::as_str)
            .map(str::to_string);
        let subs = get(&agent, &key, &with_org("/alpha/billing/subscriptions", org.as_deref()))?;
        let body = get(&agent, &key, &with_org("/alpha/billing/credits", org.as_deref()))?;
        let credits = body.get("credits").cloned().unwrap_or(Value::Null);

        let status = subs.pointer("/data/status").and_then(Value::as_str).map(str::to_string);
        let plan_id = subs
            .pointer("/data/planId")
            .and_then(Value::as_str)
            .filter(|_| status.as_deref().is_some_and(|s| ACTIVE.contains(&s)))
            .map(str::to_string);

        let period_end = subs
            .pointer("/data/currentPeriodEnd")
            .and_then(Value::as_str)
            .map(str::to_string);
        // `windowLimits` sits next to `credits`, not inside it (the CLI's
        // `projectUsageView` reads `credits.windowLimits` of the whole body).
        let window_limits = body
            .get("windowLimits")
            .or_else(|| credits.get("windowLimits"))
            .filter(|v| !v.is_null())
            .cloned();
        Ok(Billing {
            user_name,
            plan_id,
            plan_status: status,
            monthly_credits: number(&credits, "monthlyCredits"),
            purchased_credits: number(&credits, "purchasedCredits"),
            free_credits: number(&credits, "freeCredits"),
            period_end,
            window_limits,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The newest model catalog the CLI cached (it refreshes it every ~15 min),
/// from whichever home it runs under. Returns the catalog body as is.
#[tauri::command]
pub fn model_catalog() -> Result<Value, String> {
    let homes: Vec<PathBuf> = ["HOME", "USERPROFILE"]
        .iter()
        .filter_map(|key| std::env::var_os(key))
        .map(PathBuf::from)
        .collect();
    let newest = homes
        .iter()
        .filter_map(|home| std::fs::read_dir(home.join(".commandcode/cache/model-catalog/v1")).ok())
        .flat_map(|dir| dir.flatten())
        .filter(|entry| entry.path().extension().is_some_and(|e| e == "json"))
        .filter_map(|entry| {
            let modified = entry.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
            Some((modified, entry.path()))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
        .ok_or("모델 목록을 아직 받지 못했습니다. 대화를 한 번 시작하면 생깁니다.")?;
    let text = std::fs::read_to_string(&newest).map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    json.get("body").cloned().ok_or_else(|| "모델 목록 형식을 알 수 없습니다.".into())
}
