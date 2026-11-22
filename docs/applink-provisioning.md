# Applink provisioning sheet for BipodMukti

What to enter at **user.applink.com.bd → API → Create New App**, and what to set in `.env` afterwards.

## Before you start

1. **A public HTTPS host** for the callbacks. Our deployment: `https://<your-render-app>.onrender.com` (see `render.yaml`). Any HTTPS host works.
2. **The egress IP of that server**, for the app's allowed host addresses. Run this on the server itself:
   ```bash
   curl -4 https://api.ipify.org
   ```
   Render publishes the outbound IP ranges for each region on the service's "Connect → Outbound" tab. Add all of them.
3. **Whitelisted test numbers** (Limited Production): the Banglalink SIMs used in the demo (member, two family contacts, one volunteer). Banglalink numbers start with 019 or 014.

## Basic details

| Field | Value |
|---|---|
| Application name | BipodMukti |
| Description | Safety check-ins for basic phones in floods and cyclones. People dial a USSD code or send an SMS to say they are safe or need help; their family contacts get an SMS alert, with escalation to the next contact and local volunteers when nobody acknowledges. |
| APIs | SMS, USSD, Subscription (OTP comes with Subscription activation; select it if listed separately) |
| Number masking | Off (plain numbers). Family contacts are typed in as numbers, so we need plain MSISDNs. Ask Applink if masking is required. |

## SMS

| Field | Value |
|---|---|
| Keyword | `BM` (fallback: `BIPOD`) |
| Shortcode | assigned by Applink, put it in `APPLINK_SMS_SHORTCODE` |
| MO (receive) URL | `https://<host>/api/applink/sms/receive` |
| Delivery report URL | `https://<host>/api/applink/sms/report` |
| MO enabled | Yes |
| Charging | Free to the subscriber |

## USSD

| Field | Value |
|---|---|
| USSD code | assigned by Applink, put it in `APPLINK_USSD_CODE` |
| Receive URL | `https://<host>/api/applink/ussd/receive` |
| Charging | Free to the subscriber |

## Subscription

| Field | Value |
|---|---|
| Notification URL | `https://<host>/api/applink/subscription/notify` |
| Frequency | Monthly |
| Charging | Free during the pilot (paid "Family Shield" plan comes after the pilot; see the proposal) |

## After approval

Applink shows the `applicationId` in the portal and emails the API password to the registered address. Put both in the host's environment (never in git):

```
SIMULATOR_ENABLED=false
APPLINK_APP_ID=APP_......
APPLINK_PASSWORD=......
APPLINK_SMS_SHORTCODE=.....
APPLINK_USSD_CODE=*...#
```

Then check connectivity from the server with the cheapest call (Base Size), in the console: **Check Applink**. `S1000` means credentials, IP and provisioning are all correct. `E1313` = credentials, `E1303` = server IP not allowed, `E1309` = API not provisioned, `E1343` = number not whitelisted.

## Questions for the Applink mentoring session (24 to 30 Nov)

1. Can an app send MT SMS to a number that has not subscribed to it (a family contact receiving their first alert or invitation)? If not, should the contact first opt in with `BM YES`, or through Subscription?
2. Are delivery reports available in Limited Production, and how fast do they usually arrive?
3. Can one app have both a USSD code and an SMS keyword on the same shortcode? Which USSD code format will we get?
4. Is the `vlrAddress` on the USSD callback usable to tell which upazila the caller is in? (We do not rely on it.)
5. What are the default per-second and per-day transaction limits (E1318/E1319) in Limited Production, and can they be raised for a roll call?
6. For the paid "Family Shield" plan after the pilot: which subscription price points and frequencies are allowed, and what is the revenue share?
7. Is `tel:all` broadcast allowed for public safety warnings to the whole subscriber base?
