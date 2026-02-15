# Blur API Documentation - Loan Endpoints

Documentation complète pour utiliser l'API Blur avec RapidAPI pour créer et gérer les offres de prêt sur Blend.

## Configuration de Base

### Headers requis
```javascript
const headers = {
  'x-rapidapi-key': '704e8dbf9amshc6a2d639f31199cp1985abjsnfc01d357c4e8',
  'x-rapidapi-host': 'blur.p.rapidapi.com',
  'Content-Type': 'application/json'
};
```

### Base URL
```
https://blur.p.rapidapi.com
```

---

## Authentication Flow

### 1. Retrieve Auth Challenge
**Endpoint:** `POST /auth/challenge`

Génère un message de challenge à signer avec votre wallet.

**Body:**
```json
{
  "walletAddress": "0x0901104C53f6bc215204843fD33d62958A333DF8"
}
```

**Response:**
```json
{
  "data": {
    "message": "0x1a2b3c...",
    "expiresAt": "2026-02-08T12:30:00Z"
  }
}
```

### 2. Sign Message
Utilisez `ethers.js` pour signer le message reçu :

```typescript
import { ethers } from 'ethers';

const signer = provider.getSigner();
const signature = await signer.signMessage(challengeMessage);
```

### 3. Retrieve Auth Token
**Endpoint:** `POST /auth/login`

Échangez la signature contre un token d'authentification.

**Body:**
```json
{
  "walletAddress": "0x0901104C53f6bc215204843fD33d62958A333DF8",
  "message": "0x1a2b3c...",
  "signature": "0xsignature..."
}
```

**Response:**
```json
{
  "data": {
    "authToken": "eyJhbGciOiJIUzI1NiIs..."
  }
}
```

---

## Loan Endpoints

### Create Lend ETH Order Format
**Endpoint:** `POST /v1/blend/loan-offer/format`

Crée et formate une offre de prêt ETH à soumettre à la blockchain.

**Description:**
Cet endpoint formate l'ordre de prêt ETH que vous devez soumettre à la blockchain. Pour utiliser les endpoints Blur, vous avez besoin d'un authToken. Vous pouvez en générer un en utilisant l'endpoint 'Retrieve auth challenge' avec votre adresse wallet. Une fois reçu, signez le message avec ethers.js using `ethersSigner.signMessage(response.data.message)`. Puis utilisez l'endpoint 'Retrieve auth token' en fournissant les paramètres de réponse du challenge plus la signature générée.

**Headers supplémentaires:**
```json
{
  "authorization": "Bearer {authToken}"
}
```

**Body Parameters:**

| Paramètre | Type | Description | Exemple |
|-----------|------|-------------|---------|
| `orders` | Array | Tableau contenant les détails de l'offre | `[{...}]` |
| `orders[].rate` | Number | APR en basis points (100 = 1%) | `1000` = 10% APR |
| `orders[].maxAmount` | String | Montant maximum en ETH | `"0.1"` |
| `orders[].totalAmount` | String | Montant total en ETH | `"0.1"` |
| `orders[].expirationTime` | String | Date d'expiration ISO 8601 | `"2026-03-08T21:40:08.381Z"` |
| `orders[].contractAddress` | String | Adresse de la collection (lowercase) | `"0x5af0d9827e0c53e4799bb226655a1de152a425a5"` |
| `userAddress` | String | Adresse du wallet (lowercase) | `"0x0901104c53f6bc215204843fd33d62958a333df8"` |
| `contractAddress` | String | Adresse de la collection (lowercase) | `"0x5af0d9827e0c53e4799bb226655a1de152a425a5"` |

**Constraints:**
- `maxAmount` et `totalAmount` doivent être des multiples de **0.1 ETH**
- `contractAddress` doit être en **lowercase**
- `userAddress` doit être en **lowercase**
- `expirationTime` doit être au format **ISO 8601** et dans le futur

**Request Example:**
```javascript
const url = 'https://blur.p.rapidapi.com/v1/blend/loan-offer/format';
const options = {
  method: 'POST',
  headers: {
    'x-rapidapi-key': '704e8dbf9amshc6a2d639f31199cp1985abjsnfc01d357c4e8',
    'x-rapidapi-host': 'blur.p.rapidapi.com',
    'Content-Type': 'application/json',
    'authorization': `Bearer ${authToken}`
  },
  body: JSON.stringify({
    orders: [
      {
        rate: 5000,  // 50% APR
        maxAmount: '0.1',  // 0.1 ETH
        totalAmount: '0.1',
        expirationTime: '2026-03-08T21:40:08.381Z',
        contractAddress: '0x5af0d9827e0c53e4799bb226655a1de152a425a5'
      }
    ],
    userAddress: '0x0901104c53f6bc215204843fd33d62958a333df8',
    contractAddress: '0x5af0d9827e0c53e4799bb226655a1de152a425a5'
  })
};

try {
  const response = await fetch(url, options);
  const result = await response.json();
  console.log(result);
} catch (error) {
  console.error(error);
}
```

**Response Example:**
```json
{
  "data": {
    "order": {
      "id": "0x1a2b3c...",
      "nonce": 12345,
      "totalAmount": "0.1",
      "rate": 5000,
      "expirationTime": 1709942408,
      "contractAddress": "0x5af0d9827e0c53e4799bb226655a1de152a425a5"
    },
    "signature": "0xsignature..."
  }
}
```

---

### Create Borrow ETH Order Format
**Endpoint:** `POST /v1/blend/loan-offer/borrow`

Crée et formate une offre d'emprunt ETH contre un NFT, à soumettre à la blockchain.

**Description:**
Cet endpoint formate l'ordre d'emprunt ETH. L'emprunteur utilise cette fonction pour emprunter des ETH contre son NFT. Il doit avoir un authToken valide pour utiliser cet endpoint.

**Headers supplémentaires:**
```json
{
  "authorization": "Bearer {authToken}"
}
```

**Body Parameters:**

| Paramètre | Type | Description | Exemple |
|-----------|------|-------------|---------|
| `contractAddress` | String | Adresse de la collection (lowercase) | `"0x5af0d9827e0c53e4799bb226655a1de152a425a5"` |
| `userAddress` | String | Adresse du wallet emprunteur (lowercase) | `"0x4f56sd4f56s4d5f64sd56f456sd4f56sd4f5"` |
| `matchingParameters` | Object | Paramètres de correspondance d'offre | `{...}` |
| `matchingParameters.takeCount` | Number | Nombre d'offres à accepter | `1` |
| `matchingParameters.totalBorrowAmount` | Object | Montant total à emprunter | `{...}` |
| `matchingParameters.totalBorrowAmount.amount` | String | Montant en ETH | `"2.82"` |
| `matchingParameters.totalBorrowAmount.unit` | String | Unité (toujours "ETH") | `"ETH"` |
| `safetyParameters` | Array | Tableau avec détails de sécurité par NFT | `[{...}]` |
| `safetyParameters[].tokenId` | String | ID du NFT à emprunter | `"1343"` |
| `safetyParameters[].borrowAmount` | Object | Montant à emprunter pour ce NFT | `{...}` |
| `safetyParameters[].borrowAmount.amount` | String | Montant en ETH | `"2.82"` |
| `safetyParameters[].borrowAmount.unit` | String | Unité (toujours "ETH") | `"ETH"` |
| `safetyParameters[].interestRateBips` | Number | Taux d'intérêt en basis points (100 = 1%) | `9000` = 90% APR |

**Constraints:**
- `contractAddress` doit être en **lowercase**
- `userAddress` doit être en **lowercase**
- `interestRateBips` doit être un nombre entier
- Le montant total doit correspondre au montant demandé

**Request Example:**
```javascript
const url = 'https://blur.p.rapidapi.com/v1/blend/loan-offer/borrow';
const options = {
  method: 'POST',
  headers: {
    'x-rapidapi-key': '704e8dbf9amshc6a2d639f31199cp1985abjsnfc01d357c4e8',
    'x-rapidapi-host': 'blur.p.rapidapi.com',
    'Content-Type': 'application/json',
    'authorization': `Bearer ${authToken}`
  },
  body: JSON.stringify({
    contractAddress: '0x5af0d9827e0c53e4799bb226655a1de152a425a5',
    userAddress: '0x4f56sd4f56s4d5f64sd56f456sd4f56sd4f5',
    matchingParameters: {
      takeCount: 1,
      totalBorrowAmount: {
        amount: '2.82',
        unit: 'ETH'
      }
    },
    safetyParameters: [
      {
        tokenId: '1343',
        borrowAmount: {
          amount: '2.82',
          unit: 'ETH'
        },
        interestRateBips: 9000  // 90% APR
      }
    ]
  })
};

try {
  const response = await fetch(url, options);
  const result = await response.json();
  console.log(result);
} catch (error) {
  console.error(error);
}
```

**Response Example:**
```json
{
  "data": {
    "order": {
      "id": "0x1a2b3c...",
      "nonce": 12345,
      "borrowAmount": "2.82",
      "interestRate": 9000,
      "contractAddress": "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
      "tokenIds": ["1343"]
    },
    "signature": "0xsignature..."
  }
}
```

---

### Cancel Active User Lend ETH Offer
**Endpoint:** `POST /v1/blend/loan-offer/cancel/format`

Annule une offre de prêt ETH active (lending offer).

**Description:**
Cet endpoint est utilisé pour annuler une offre de prêt ETH active. Vous devez avoir un authToken valide pour utiliser cet endpoint. Une fois la cancelation formatée, vous devrez la soumettre à la blockchain.

**Headers supplémentaires:**
```json
{
  "authorization": "Bearer {authToken}"
}
```

**Body Parameters:**

| Paramètre | Type | Description | Exemple |
|-----------|------|-------------|---------|
| `hashes` | Array | Tableau des hashes des offres à annuler | `["0xf5e99fd5a4f8sd4f8sdfb0fa5a07b025df18a31da752354f896ac2044a838ee5a"]` |
| `userAddress` | String | Adresse du wallet (lowercase) | `"0xe61dcc954f56sd4f8dsf49sd4dfdsf"` |
| `contractAddress` | String | Adresse de la collection (lowercase) | `"0x5af0d9827e0c53e4799bb226655a1de152a425a5"` |

**Constraints:**
- `hashes` doit contenir au moins un hash valide
- `userAddress` doit être en **lowercase**
- `contractAddress` doit être en **lowercase**
- Seules les offres actives du wallet peuvent être annulées
- Les hashes doivent correspondre à des offres existantes du user

**Request Example:**
```javascript
const url = 'https://blur.p.rapidapi.com/v1/blend/loan-offer/cancel/format';
const options = {
  method: 'POST',
  headers: {
    'x-rapidapi-key': '704e8dbf9amshc6a2d639f31199cp1985abjsnfc01d357c4e8',
    'x-rapidapi-host': 'blur.p.rapidapi.com',
    'Content-Type': 'application/json',
    'authorization': `Bearer ${authToken}`
  },
  body: JSON.stringify({
    hashes: [
      '0xf5e99fd5a4f8sd4f8sdfb0fa5a07b025df18a31da752354f896ac2044a838ee5a'
    ],
    userAddress: '0xe61dcc954f56sd4f8dsf49sd4dfdsf',
    contractAddress: '0x5af0d9827e0c53e4799bb226655a1de152a425a5'
  })
};

try {
  const response = await fetch(url, options);
  const result = await response.json();
  console.log(result);
} catch (error) {
  console.error(error);
}
```

**Response Example:**
```json
{
  "data": {
    "cancellationOrders": [
      {
        "id": "0x1a2b3c...",
        "hash": "0xf5e99fd5a4f8sd4f8sdfb0fa5a07b025df18a31da752354f896ac2044a838ee5a",
        "status": "pending_cancellation"
      }
    ],
    "signature": "0xsignature..."
  }
}
```

---

### Create Repay Active Loan Order Format
**Endpoint:** `POST /v1/blend/lien/repay`

Crée les données d'ordre pour rembourser un prêt ETH actif (lien).

**Description:**
Cet endpoint est utilisé pour créer l'ordre de remboursement d'un prêt ETH actif. L'emprunteur utilise cette fonction pour rembourser son prêt et récupérer son NFT. Vous devez avoir un authToken valide pour utiliser cet endpoint. Une fois les données de remboursement formatées, vous devrez les soumettre à la blockchain.

**Headers supplémentaires:**
```json
{
  "authorization": "Bearer {authToken}"
}
```

**Body Parameters:**

| Paramètre | Type | Description | Exemple |
|-----------|------|-------------|---------|
| `userAddress` | String | Adresse du wallet emprunteur (lowercase) | `"0xe61dccdas7d98as7d897as89d7se7a"` |
| `lienRequests` | Array | Tableau des remboursements à effectuer | `[{...}]` |
| `lienRequests[].lienId` | String | ID du lien (prêt) à rembourser | `"1466"` |
| `lienRequests[].tokenId` | String | ID du NFT associé au prêt | `"1352"` |
| `contractAddress` | String | Adresse de la collection (lowercase) | `"0x5af0d9827e0c53e4799bb226655a1de152a425a5"` |

**Constraints:**
- `userAddress` doit être en **lowercase**
- `contractAddress` doit être en **lowercase**
- `lienId` doit correspondre à un prêt actif de l'utilisateur
- `tokenId` doit correspondre au NFT du lien
- L'utilisateur doit avoir les ETH nécessaires pour rembourser (principal + intérêts)

**Request Example:**
```javascript
const url = 'https://blur.p.rapidapi.com/v1/blend/lien/repay';
const options = {
  method: 'POST',
  headers: {
    'x-rapidapi-key': '704e8dbf9amshc6a2d639f31199cp1985abjsnfc01d357c4e8',
    'x-rapidapi-host': 'blur.p.rapidapi.com',
    'Content-Type': 'application/json',
    'authorization': `Bearer ${authToken}`
  },
  body: JSON.stringify({
    userAddress: '0xe61dccdas7d98as7d897as89d7se7a',
    lienRequests: [
      {
        lienId: '1466',
        tokenId: '1352'
      }
    ],
    contractAddress: '0x5af0d9827e0c53e4799bb226655a1de152a425a5'
  })
};

try {
  const response = await fetch(url, options);
  const result = await response.json();
  console.log(result);
} catch (error) {
  console.error(error);
}
```

**Response Example:**
```json
{
  "data": {
    "repaymentOrders": [
      {
        "lienId": "1466",
        "tokenId": "1352",
        "principalAmount": "2.82",
        "interestAmount": "0.15",
        "totalRepayAmount": "2.97",
        "status": "ready_for_repayment"
      }
    ],
    "signature": "0xsignature..."
  }
}
```

---

### Create Borrowed Buy Order Format
**Endpoint:** `POST /v1/blend/loan-offer/buy-to-borrow`

Crée un ordre d'achat ETH utilisant des fonds empruntés via Blend.

**Description:**
Cet endpoint est utilisé pour créer l'ordre d'achat d'un NFT en utilisant des fonds empruntés. L'utilisateur emprunte une partie du prix du NFT et paye le reste, tout en prenant un lien (lien) sur le NFT comme garantie. Vous devez avoir un authToken valide pour utiliser cet endpoint.

**Headers supplémentaires:**
```json
{
  "authorization": "Bearer {authToken}"
}
```

**Body Parameters:**

| Paramètre | Type | Description | Exemple |
|-----------|------|-------------|---------|
| `contractAddress` | String | Adresse de la collection (lowercase) | `"0x5af0d9827e0c53e4799bb226655a1de152a425a5"` |
| `userAddress` | String | Adresse du wallet acheteur (lowercase) | `"0xe61dcc958fc886924f97a1ba7af2781361f58e7a"` |
| `orders` | Array | Tableau des NFTs à acheter avec emprunt | `[{...}]` |
| `orders[].tokenId` | String | ID du NFT à acheter | `"919"` |
| `orders[].price` | Object | Prix du NFT | `{...}` |
| `orders[].price.amount` | String | Montant en ETH | `"3.85"` |
| `orders[].price.unit` | String | Unité (toujours "ETH") | `"ETH"` |
| `matchingParameters` | Object | Paramètres de correspondance d'emprunt | `{...}` |
| `matchingParameters.totalBorrowAmount` | Object | Montant total à emprunter | `{...}` |
| `matchingParameters.totalBorrowAmount.amount` | String | Montant en ETH | `"3.4"` |
| `matchingParameters.totalBorrowAmount.unit` | String | Unité (toujours "ETH") | `"ETH"` |
| `matchingParameters.takeCount` | Number | Nombre d'offres de prêt à accepter | `1` |
| `safetyParameters` | Object | Paramètres de sécurité | `{...}` |
| `safetyParameters.maxWeeklyInterest` | Object | Intérêt maximum par semaine | `{...}` |
| `safetyParameters.maxWeeklyInterest.amount` | String | Montant en ETH | `"0.718087"` |
| `safetyParameters.maxWeeklyInterest.unit` | String | Unité (toujours "ETH") | `"ETH"` |

**Constraints:**
- `contractAddress` doit être en **lowercase**
- `userAddress` doit être en **lowercase**
- Le montant emprunté doit être inférieur au prix du NFT
- L'utilisateur doit payer la différence (prix - montant emprunté)
- `maxWeeklyInterest` doit être réaliste par rapport au taux d'intérêt des offres disponibles
- `takeCount` doit être >= 1

**Request Example:**
```javascript
const url = 'https://blur.p.rapidapi.com/v1/blend/loan-offer/buy-to-borrow';
const options = {
  method: 'POST',
  headers: {
    'x-rapidapi-key': '704e8dbf9amshc6a2d639f31199cp1985abjsnfc01d357c4e8',
    'x-rapidapi-host': 'blur.p.rapidapi.com',
    'Content-Type': 'application/json',
    'authorization': `Bearer ${authToken}`
  },
  body: JSON.stringify({
    contractAddress: '0x5af0d9827e0c53e4799bb226655a1de152a425a5',
    userAddress: '0xe61dcc958fc886924f97a1ba7af2781361f58e7a',
    orders: [
      {
        tokenId: '919',
        price: {
          amount: '3.85',
          unit: 'ETH'
        }
      }
    ],
    matchingParameters: {
      totalBorrowAmount: {
        amount: '3.4',
        unit: 'ETH'
      },
      takeCount: 1
    },
    safetyParameters: {
      maxWeeklyInterest: {
        amount: '0.718087',
        unit: 'ETH'
      }
    }
  })
};

try {
  const response = await fetch(url, options);
  const result = await response.json();
  console.log(result);
} catch (error) {
  console.error(error);
}
```

**Response Example:**
```json
{
  "data": {
    "buyOrder": {
      "id": "0x1a2b3c...",
      "tokenId": "919",
      "nftPrice": "3.85",
      "borrowAmount": "3.4",
      "buyerPayment": "0.45",
      "matchedLoans": 1,
      "lienId": "1789",
      "weeklyInterestCost": "0.718087"
    },
    "signature": "0xsignature..."
  }
}
```

---

### Submit Loan Offer Format
**Endpoint:** `POST /v1/blend/loan-offer/submit`

Soumet l'offre de prêt formatée à la blockchain pour qu'elle soit active.

**Description:**
Cet endpoint est utilisé pour soumettre l'offre de prêt ETH formatée à la blockchain. C'est la dernière étape après avoir utilisé le endpoint `Create lend ETH order format`. L'offre devient alors active et les emprunteurs peuvent l'accepter. Vous devez avoir un authToken valide pour utiliser cet endpoint.

**Headers supplémentaires:**
```json
{
  "authorization": "Bearer {authToken}"
}
```

**Body Parameters:**

| Paramètre | Type | Description | Exemple |
|-----------|------|-------------|---------|
| `orders` | Array | Tableau contenant les offres à soumettre | `[{...}]` |
| `orders[].signature` | String | Signature de l'offre formatée (hex) | `"0x668864c04ecd70647a47..."` |
| `orders[].marketplaceData` | String | Données de marché encodées (JSON string) | `"[...]"` |
| `userAddress` | String | Adresse du wallet prêteur (lowercase) | `"0xe61dcc958fc88692..."` |
| `contractAddress` | String | Adresse de la collection (lowercase) | `"0x306b1ea3ecdf9a..."` |

**Constraints:**
- `userAddress` doit être en **lowercase**
- `contractAddress` doit être en **lowercase**
- `signature` doit être valide et provenir du endpoint `Create lend ETH order format`
- `marketplaceData` doit correspondre aux données retournées par le endpoint de format
- L'offre doit avoir été formatée récemment (pas d'expiration)

**Request Example:**
```javascript
const url = 'https://blur.p.rapidapi.com/v1/blend/loan-offer/submit';
const options = {
  method: 'POST',
  headers: {
    'x-rapidapi-key': '704e8dbf9amshc6a2d639f31199cp1985abjsnfc01d357c4e8',
    'x-rapidapi-host': 'blur.p.rapidapi.com',
    'Content-Type': 'application/json',
    'authorization': `Bearer ${authToken}`
  },
  body: JSON.stringify({
    orders: [
      {
        signature: '0x668864c04ecd70647a47ae7daf209dca4b8a5bff3146026e68f7daswrd1e30b92682b60bd964bcbd75adb396e729d092897a26d25ebf8f1e1c',
        marketplaceData: '["tnG8YDQjq1QMlQmZIjMUwTbi7GPCQEZO7Jf0uKm2XuvrJ9GEpH3dasdwkUSAhEuUd6O6m6nDbv0MYrkkF1acvlI7LouVvHigiKqXxY2FF/X1DuwMmwG0j254/mnckyp1eQevcragR/XhDUtF6kIi82BUOMr55zCpGM0M4CbsBNL9hooTijUJt6SBHvC7FWFsasUC6Ozvq6PmqWXwzrBhumBrel98NHcbHxzWdtNnuw3e4Ul0cuW8a8RCziTrdCYhsjTgIr/V+XW/rqz5HVpWhuvtvB1MOpQcF3DNZl/T29D2MvCFPYPSHPk0AC4LJPcwqdOgaZV9iWjnY1m/5jJ7Xe9V2ykl/G3E8n9NPXe69C0iiOmTYdtHKEiakZ+JQucgvgin4s6CAR+DPsPAXgNxKaW7atuh8Jqtw2/2buJbu7WvoryYVw0NjffS8tmI9bwtJ3iAc7gASUbGQh8AVyzE3n11dzGKceIAn6V9o0bwsegCfe3qwTO9bUuBILfOqmd0ewZzPAF4pBQUVAXfBVT5uMZ+E1NHNxN6ollfPLTplofjj9Unev8bpFAVUrohG/xtzo72SK+ISxuf62jmCwjqfcJPYCA3wcBmDL2kwSuOxaNJhm802uUVgj2WgSVabxdT3Mh1U3Bx0Y3/uT/AZxnnPO7pUkTDplAQL6LwXwRWncv868CX8qjCI6dVV4R48JFDFJrUZb/4am3iZunD/aE6UQ1l/D8q2JHD7shdYndlTo8X6SMO6m6mqSAGsm7IPZpenP7MA61bgYGexNfCpNZ/94O060rl4pkxBkBWjtLzTNQ4E0Jf6DDckGnBXFsHKBJOv8HtiSuNcmT4wXlA2PJNVul+r1KbYxDMRMEm0ZLzdqYJCoqIK0iZ7/+QLG37VheKJ3fUL3eodkebtOZRlCg+/Lob3TYpsxe1+7dcNBiMQP4czGsAiUxE/Qgyd1+MVKqJE1JNfDgstAXw0rkJ3yuhWD1gcilHnADSv734wNmJGTJ+7F3t6UeIfC/dekgRYlXae+ZqACtkx3kVG5Xz0rIksN2g3CRh0qExkXpGXgWk556pZUbf0T2tWdMRPNJEbM9DXAl/SdasdAS3SRTC4u2i+43oKiLuZnSj/qx4UvWUhKUVROgE8OpDuePZYUX7DT/xeGyBpskA7a2QQJcLVBkXV7+oXpApV3sf8mTHeUBZV5kF2ZCNCpkJVQ3nEPXbYSAKkS2YgTzUNvywW7AucbQhOx+9+eEDfNoj39a69y1NBwkSIDXz1pkiBvZk316RTo8qNHtWBO6g9y5yZE41YMwVQO3J7znrQd+5OE9KhGegHm8bBEgU4m7lbmClciF0jjrO1ihkfmiiFZdlcsmuabjQAhnPqGHHUSdhTrORSYIZzloucZ+WFit26tL5J4XuZfBZdHo4pdLsx+Fo0F63In+ZpDWWhsUV4LXm1e0OdTFWtxfq/016e/qH+G5msGG5ltX1UwV+DHy7nLiLtrxXH3ojXY4YaQ90z6D7NDrv9Y348xVhb2/5HZtjEVPqtYw37mIuBrOWi3wsulSZOZEujdne0nPhE0Gn/cl0sun2WlbyWz5R5Wb/AakrxLfKBKGN6/QxjTzFDgU/5n11+Z/gPbqJlPPwCsrS4CfGhdCFzYGTpHL3fWubHP0uoZYvR8vSXHuAIZt6GMOFE/124zbKXb53M1UwS16D/vrMborCs9i5njHh0yE71BWl9k/3oQloQeBTtuquKRiZmjxg13qHeo8ZSRWbbUZK/2jfHbh6cVzsj4eOopWSzj6wtrqmkClykaUS3KfasEFHxnZf05oGmKXcNoCpVo18YtQgzRqhMluqjN4RdBgHgNTbYeq3aJhVvF1x6RhXQp4V/RcANRMTttod0P+RiBpFXgZMKpCkeY/99Ez4O6iWqn1794zYI=","t11QWRcZeNafWs2goLyLJQ==","iYSwBG9rG2XD2Oqscg6LeQ=="]'
      }
    ],
    userAddress: '0xe61dcc958fc88692dasdweweeasf58e7a',
    contractAddress: '0x306b1ea3ecdf9dasdasd0bbda052ed4a9f949'
  })
};

try {
  const response = await fetch(url, options);
  const result = await response.json();
  console.log(result);
} catch (error) {
  console.error(error);
}
```

**Response Example:**
```json
{
  "data": {
    "transactionHash": "0x1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t",
    "status": "submitted",
    "offerId": "0x668864c04ecd70647a47ae7daf209dca4b8a5bff3146026e68f7da1e30b9",
    "confirmation": "Your loan offer has been submitted to the blockchain and is now active."
  }
}
```

---

## Query / Retrieve Endpoints

### Retrieve Active Collection / User Loans Offers
**Endpoint:** `GET /v1/blend/active-loans/{collection}`

Récupère les offres de prêt actives pour une collection ou un utilisateur spécifique.

**Description:**
Cet endpoint est utilisé pour récupérer la liste des offres de prêt ETH actives pour une collection donnée ou pour un utilisateur spécifique. Vous pouvez utiliser l'adresse de la collection ou l'adresse du wallet de l'utilisateur.

**Query Parameters:**

| Paramètre | Type | Description | Exemple |
|-----------|------|-------------|---------|
| `collection` | String (URL path) | Adresse de la collection OU adresse du wallet utilisateur | `0x5af0d9827e0c53e4799bb226655a1de152a425a5` |

**Optional Query String Parameters:**
```
?userAddress=0x... (pour filtrer les offres d'un utilisateur spécifique)
?limit=50 (nombre maximum de résultats à retourner)
?offset=0 (pour la pagination)
```

**Constraints:**
- L'adresse doit être valide (0x + 40 caractères hex)
- Peut être soit une collection address soit une user address
- N'appelle pas à disposition d'authToken (endpoint public)

**Request Example:**
```javascript
// Récupérer les offres de prêt pour une collection
const collectionUrl = 'https://blur.p.rapidapi.com/v1/blend/active-loans/0x5af0d9827e0c53e4799bb226655a1de152a425a5';

// Ou récupérer les offres d'un utilisateur spécifique
const userUrl = 'https://blur.p.rapidapi.com/v1/blend/active-loans/0xe61dcc958fc886924f97a1ba7af2781361e58e7a';

const options = {
  method: 'GET',
  headers: {
    'x-rapidapi-key': '704e8dbf9amshc6a2d639f31199cp1985abjsnfc01d357c4e8',
    'x-rapidapi-host': 'blur.p.rapidapi.com',
    'Content-Type': 'application/json'
  }
};

try {
  const response = await fetch(collectionUrl, options);
  const result = await response.json();
  console.log(result);
} catch (error) {
  console.error(error);
}
```

**Response Example (Collection):**
```json
{
  "data": {
    "collection": "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
    "activeOffers": [
      {
        "offerId": "0x668864c04ecd70647a47ae7daf209dca4b8a5bff...",
        "lender": "0xe61dcc958fc886924f97a1ba7af2781361e58e7a",
        "rate": 5000,
        "maxAmount": "0.1",
        "expirationTime": "2026-03-08T21:40:08.381Z",
        "totalAvailable": "0.1",
        "taken": "0"
      },
      {
        "offerId": "0x1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p...",
        "lender": "0xf1e2d3c4b5a69f8e7d6c5b4a3f2e1d0c",
        "rate": 4500,
        "maxAmount": "0.2",
        "expirationTime": "2026-03-10T15:00:00.000Z",
        "totalAvailable": "0.15",
        "taken": "0.05"
      }
    ],
    "totalActiveOffers": 2,
    "totalLiquidityAvailable": "0.25"
  }
}
```

**Response Example (User):**
```json
{
  "data": {
    "userAddress": "0xe61dcc958fc886924f97a1ba7af2781361e58e7a",
    "lenderOffers": [
      {
        "offerId": "0x668864c04ecd70647a47ae7daf209dca4b8a5bff...",
        "collection": "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
        "rate": 5000,
        "maxAmount": "0.1",
        "expirationTime": "2026-03-08T21:40:08.381Z",
        "totalAvailable": "0.1",
        "taken": "0"
      }
    ],
    "borrowerLoans": [
      {
        "lienId": "1466",
        "collection": "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
        "tokenId": "1352",
        "borrowAmount": "2.82",
        "remainingBalance": "2.85",
        "interestRate": 5000,
        "startDate": "2026-02-08T10:30:00.000Z",
        "expirationTime": "2026-03-08T10:30:00.000Z"
      }
    ]
  }
}
```

---

### Retrieve Aggregated Loan Offers
**Endpoint:** `GET /v1/blend/aggregated-loan-offers/{collection}`

Récupère les niveaux d'offres de prêt agrégés pour une collection.

**Description:**
Cet endpoint est utilisé pour récupérer les offres de prêt agrégées par taux d'intérêt pour une collection spécifique. Au lieu de lister chaque offre individuelle, les données sont agrégées par niveau de prix/taux, ce qui donne une vue de marché du book des offres de prêt (lending book).

**Query Parameters:**

| Paramètre | Type | Description | Exemple |
|-----------|------|-------------|---------|
| `collection` | String (URL path) | Adresse de la collection | `0x5af0d9827e0c53e4799bb226655a1de152a425a5` |

**Optional Query String Parameters:**
```
?limit=50 (nombre maximum de niveaux de prix à retourner)
?offset=0 (pour la pagination)
```

**Constraints:**
- L'adresse de collection doit être valide (0x + 40 caractères hex)
- N'appelle pas à disposition d'authToken (endpoint public)
- Les données sont agrégées par taux d'intérêt

**Request Example:**
```javascript
const url = 'https://blur.p.rapidapi.com/v1/blend/aggregated-loan-offers/0x5af0d9827e0c53e4799bb226655a1de152a425a5';
const options = {
  method: 'GET',
  headers: {
    'x-rapidapi-key': '704e8dbf9amshc6a2d639f31199cp1985abjsnfc01d357c4e8',
    'x-rapidapi-host': 'blur.p.rapidapi.com',
    'Content-Type': 'application/json'
  }
};

try {
  const response = await fetch(url, options);
  const result = await response.json();
  console.log(result);
} catch (error) {
  console.error(error);
}
```

**Response Example:**
```json
{
  "data": {
    "collection": "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
    "aggregatedOffers": [
      {
        "rate": 3000,
        "numberOfOffers": 5,
        "totalLiquidity": "2.5",
        "avgLoanSize": "0.5",
        "minLoanAmount": "0.1",
        "maxLoanAmount": "1.0"
      },
      {
        "rate": 4000,
        "numberOfOffers": 12,
        "totalLiquidity": "6.2",
        "avgLoanSize": "0.52",
        "minLoanAmount": "0.1",
        "maxLoanAmount": "2.0"
      },
      {
        "rate": 5000,
        "numberOfOffers": 8,
        "totalLiquidity": "3.8",
        "avgLoanSize": "0.475",
        "minLoanAmount": "0.1",
        "maxLoanAmount": "1.5"
      },
      {
        "rate": 7500,
        "numberOfOffers": 3,
        "totalLiquidity": "1.2",
        "avgLoanSize": "0.4",
        "minLoanAmount": "0.1",
        "maxLoanAmount": "0.8"
      }
    ],
    "marketStats": {
      "bestRate": 3000,
      "worstRate": 7500,
      "totalLiquidity": "13.7",
      "totalOffers": 28,
      "avgRate": 4625
    }
  }
}
```

---

### Retrieve Active Collection / User Lend ETH Offers
**Endpoint:** `GET /v1/portfolio/{collection}/loan-offers`

Récupère les offres de prêt ETH actives pour une collection ou un utilisateur.

**Description:**
Cet endpoint est utilisé pour récupérer la liste des offres de prêt ETH actives pour une collection donnée ou pour un utilisateur spécifique. Vous pouvez entrer l'adresse de la collection ou l'adresse du wallet de l'utilisateur. **Cet endpoint nécessite un authToken valide** pour y accéder.

**Headers supplémentaires:**
```json
{
  "authorization": "Bearer {authToken}"
}
```

**Query Parameters:**

| Paramètre | Type | Description | Exemple |
|-----------|------|-------------|---------|
| `collection` | String (URL path) | Adresse de la collection OU adresse du wallet utilisateur | `0x5af0d9827e0c53e4799bb226655a1de152a425a5` |

**Optional Query String Parameters:**
```
?limit=50 (nombre maximum de résultats)
?offset=0 (pour la pagination)
?sortBy=rate (trier par rate, amount, ou date)
?sortOrder=asc (asc ou desc)
```

**Constraints:**
- L'adresse doit être valide (0x + 40 caractères hex)
- **Nécessite un authToken** (contrairement à d'autres endpoints GET)
- Peut être soit une collection address soit une user address
- L'authToken doit être valide et non expiré

**Request Example:**
```javascript
// Récupérer les offres de prêt pour une collection
const collectionUrl = 'https://blur.p.rapidapi.com/v1/portfolio/0x5af0d9827e0c53e4799bb226655a1de152a425a5/loan-offers';

// Ou récupérer les offres d'un utilisateur avec filtrage
const userUrl = 'https://blur.p.rapidapi.com/v1/portfolio/0xe61dcc958fc886924f97a1ba7af2781361e58e7a/loan-offers?limit=20&sortBy=rate&sortOrder=asc';

const options = {
  method: 'GET',
  headers: {
    'x-rapidapi-key': '704e8dbf9amshc6a2d639f31199cp1985abjsnfc01d357c4e8',
    'x-rapidapi-host': 'blur.p.rapidapi.com',
    'Content-Type': 'application/json',
    'authorization': `Bearer ${authToken}`
  }
};

try {
  const response = await fetch(collectionUrl, options);
  const result = await response.json();
  console.log(result);
} catch (error) {
  console.error(error);
}
```

**Response Example:**
```json
{
  "data": {
    "collection": "0x5af0d9827e0c53e4799bb226655a1de152a425a5",
    "lendOffers": [
      {
        "offerId": "0x668864c04ecd70647a47ae7daf209dca4b8a5bff...",
        "lender": "0xe61dcc958fc886924f97a1ba7af2781361e58e7a",
        "rate": 3500,
        "maxAmount": "0.5",
        "totalAmount": "0.5",
        "expirationTime": "2026-04-08T21:40:08.381Z",
        "totalAvailable": "0.5",
        "taken": "0",
        "createdAt": "2026-02-08T10:30:00.000Z"
      },
      {
        "offerId": "0x1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p...",
        "lender": "0xf1e2d3c4b5a69f8e7d6c5b4a3f2e1d0c",
        "rate": 4000,
        "maxAmount": "1.0",
        "totalAmount": "1.0",
        "expirationTime": "2026-03-15T15:00:00.000Z",
        "totalAvailable": "0.8",
        "taken": "0.2",
        "createdAt": "2026-02-05T14:20:00.000Z"
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 2
    }
  }
}
```

---

## Erreurs Courantes

### "amount not a multiple of tick size"
**Cause:** Le montant n'est pas un multiple de 0.1 ETH  
**Solution:** Utiliser 0.1, 0.2, 0.3, etc. (pas 0.07, 0.05, etc.)

### "user does not have enough blur pool balance"
**Cause:** Solde insuffisant dans le Blur Pool  
**Solution:** Déposer au moins le montant demandé dans le Blur Pool sur blur.io

### "contractAddress not in supported collection list"
**Cause:** La collection n'est pas supportée pour les loans Blend  
**Solution:** Vérifier que c'est une collection acceptée par Blur Blend

### Invalid format (lowercase issue)
**Cause:** Addresses en uppercase  
**Solution:** Toujours utiliser `.toLowerCase()` pour les addresses

---

## Best Practices

1. **Avant de créer une offre:**
   - Vérifier que le montant est un multiple de 0.1 ETH
   - Vérifier que le solde est suffisant
   - Utiliser le loan-pricer pour calculer l'APR optimal

2. **Dates d'expiration:**
   - Utiliser un format ISO 8601 valide
   - La date doit être dans le futur
   - Exemple: `new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()`

3. **Addresses:**
   - Toujours convertir en lowercase
   - Vérifier que l'adresse est valide (0x + 40 caractères hex)

---

## Collections Supportées

Parmi les collections testées :
- `0x5af0d9827e0c53e4799bb226655a1de152a425a5` - Azuki Elementals
- (Autres collections à ajouter)

---

## Notes

- L'authToken peut avoir une durée d'expiration limitée
- Les offres doivent être signées avant submission
- Le montant minimum pour les offres est **0.1 ETH**

---

**Dernière mise à jour:** 8 février 2026
