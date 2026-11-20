'use strict';
// Texto literal seguro dentro de um script do PowerShell. Aspas simples não bastam: o PowerShell também
// trata ‘ ’ ‚ ‛ como aspas, e um nome de usuário como "D'Ávila" quebrava o comando (ou permitia injetar
// outro). Em base64 qualquer caractere passa sem interpretação.
function psLiteral(value) {
  const b64 = Buffer.from(String(value ?? ''), 'utf8').toString('base64');
  return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`;
}

module.exports = { psLiteral };
