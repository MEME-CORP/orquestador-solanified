

Flujo completo:

Reglas: 
- se envía siempre al orquestador la wallet del usuario conectado
- todos los envíos desde el orquestador a la api deben tener rate limits
- si el orquesdor recibe un 400 o error desde la api entonces se activa un retry mechanism
- Todas las transacciones de compra y de venta deben calcularse para mantener un mínimo de 0.0001 sol retenidos. 
- todas las transacciones de venta deben calcularse para 

Tareas: asegurarse que las cuentas siempre mantengan el mínimo de sol para que cada wallet pueda enviar y recibir transacciones

1. Crear Wallet in app:

- Cliente: el usuario se conecta con una wallet
- Cliente: el usuario entra en crear bundler
- Cliente: se mira si el usuario está registrado en la base de datos. Si no entonces se le pide crear una wallet in app
- Cliente: el usuario solicita crear una wallet in app, enviando la wallet adress con la que el usuario está conectado
- Orquestador: el orquestador recibe la petición y manda la solicitud al endpoint /wallet/create. 
- Orquestador: el orquestador recibe la llave pública y privada como respuesta de la api
- Orquestador: el orquestador toma estos valores y junto con la wallet del usuario, registra el usuario en la table users llenando las columnas: user_wallet, wallet_in_app_private_key, wallet_in_app_public_key, y estableciendo saldo_sol en 0
- cliente: el usuario ve en la ui los valores wallet_in_app_public_key y saldo_sol
- cliente: se le pide al usuario enviar a la wallet in app fondos en sol
- Cliente: se activa un botón para que el usuario clickee cuando ya haya enviado fondos a la wallet in app
- cliente: el usuario activa el botón para notificar que ya envió saldos a la wallet in app, se envía la wallet del usuario al orquestador
- orquestador: El orquestador recibe la petición y consulta en la tabla users usando la wallet del usuario la columna wallet_in_app_public_key
- orquestador: envía el valor consultado en la base de datos al endpoint de la api /wallet/{publicKey}/balance/sol
- orquestador: recibe el valor balanceSol de la api y lo registra en la columna saldo_sol del usuario que envió la request
- cliente: en la ui el usuario puede ver ahora el saldo actualizado de su wallet in app
- cliente: la ui solo permite continuar con la creación del bundler cuando el saldo es mayor a 0.1

2. Creación del bundler:


- cliente: el usaurio continua clickeando en crear bundler
- cliente: aparece un pop up preguntando: saldo a usar para el bundler advirtiendole que esa wallet será la dev wallet para la compra en la creación del token
- cliente: el usurio determina el saldo para el bundler, el cual tiene 2 reglas: debe ser igual o menor al saldo en la wallet in app, debe ser valores enteros
- cliente: el usuario confirma el saldo y envía al orquestador ese dato junto a la wallet del usuario con la que está conectado
- orquestador: el orquestador recibe la solicitud. el orquestador entiende que por cada sol se debe asignar una wallet madre, así que revisa la cantidad de wallets en la tabla mother_wallets columna available con el valor true. Si la cantidad es menor al saldo enviado entonces se envía un mensaje a la ui diciendo que solo se puede {cantidad de columnas true}. Si el saldo es menor o igual a la cantidad de filas con valores true entonces se continúa con el proceso
- orquestador: el orquestar toma la cantidad de filas igual al saldo enviado. y extrae el valor de public_key de la tabla mother_wallets, luego extrae de la tabla users el valor en la columna wallet_in_app_private_key. 
- orquestador: luego el orquestador crea un nuevo registro en la tabla bundler donde llena: user_wallet_id y el status lo pone en true. posteriormente crea los registros en la tabla Mother_Wallets_asignadas  donde registra todos las filas escogidas de las mother_wallets en la columna mother_wallet_id, y los vincula con el bundler recién registrado en la tabla bundlers llenando la columna bundler_id.
- orquestador: envía los valores extraidos de la mother_wallets y de la columna wallet_in_app_private_key de la tabla users al endpoint /sol/advanced-transfer de la api. Donde transfiere desde la wallet in app de a un sol a las wallets madres.
- orquestador: el orquestador recibe la data de la api y si es exitosa se actualiza en la base de datos los saldos en la columna saldo_sol de la tabla mother_wallets, y al terminar todas las tx se actualiza en la tabla user la columna saldo_sol
- orquestador: una vez terminadas las transferencias a las wallets madres se extra el valor de la columna public_key de la tabla child_wallets de las wallets madres que se les fue transferido un sol. Se crea una lista de esas public keys siguiendo el orden teniendo en cuenta que cada mother wallet está relacionada con 4 child wallets: walletmadre1/walletchild1, walletmadre2/walletchild1, ....walletmadreN/walletchild1, walletmadre1/walletchild2, walletmadre2/walletchild2,......,walletmadreN/walletchild2, walletmadre1/walletchild3, walletmadre2/walletchild3 ,.....walletmadreN/walletchild3, walletmadre1/walletchild4, walletmadre2/walletchild4,.....walletmadre2/walletchild4
- orquestador: teniendo en cuenta que cada mother wallet está relacionada con 4 child wallets y se va a repartir el saldo de 1 sol de las wallets madre a las child se genera un randomizador con 2 condiciones: 1) el valor es entre 2 y 3. 2) la suma total de los 4 valores debe ser igual al saldo_sol de la wallet madre. el resultado será el valor a transferir de la wallet madre a la wallet chil
- orquestador:  una vez se tenga el valor a transferir a cada wallet child se inicia el proceso de transferencia en el orden de la lista creada en los pasos anteriores. De manera que se envían los datos correspondientes al endpoint /sol/advanced-transfer de la api
- orquestador: con la respuesta de la api se actualiza en la base de datos la columna saldo_sol de la tabla child_wallets y de la columna saldo_sol de la tabla mother_wallets.
- orquestador: al terminar todas las transacciones envía al cliente la notificación que el bundler fue creado exitosamente
- cliente: en el cliente le aparece ahora el total_saldo_sol de la tabla bundler de la fila con mayor id relacionada con el user wallet del usuario con un mensaje diciendo que ya se puede crear un token

3. creación y compra del token:

- cliente: el usaurio clickea en crear token en pump.fun. Aparece un pop up con un fomulario preguntándole la siguiente información: name, symbol, description, logo, twitter, telegram, website, devBuyAmount, add_slippage, add priorityFee
- cliente: confirma la información y la envía al orquestador
- orquestador: recibe la información y envía el logo al endpoint /upload/pinata-image del cual recibe una url. 
- orquestador: recopila todos los datos de las wallets y del token junto al url recibido (en lugar de la imagen del logo) para enviarlo al endpoint /pump/advanced-create de la api
- orquestador: al recibir la transacción de la api como exitosa se registra en la base de datos: tabla tokens columnas name, symbol, description, imageUrl, twitter, telegram, website, devBuyAmount, contracAdress; tabla user, la columna saldo spl; la columna token_name de la tabla bundlers  
- orquestador: el orquestador automaticamente empieza con la compra del token recien hecho con las wallets de kas child wallets de las wallets madre asignadas dentro del bundler cuyo status es true. De esta manera de obtienen los private keys de todas las child wallets de las wallets madres asignadas para crear las transacciones de compra enviandolos con los saldos que tienen las child wallets. Se envía al endpoint /pump/advanced-buy
- orquestador: el orquestador cuando recibe la transacción exitosa actualiza la base de datos, actualizando las columnas: saldo_sol y saldo_spl de la tabla child_wallets
- orquestador: una vez se termine el proceso de compra del token creado en pump.fun y actualizada la base de datos, se envía la notificación al cliente diciendo que la compra del bundler y la creación del token ha sido exitosa
- cliente: se muestra ahora la opción de venta del bundler y se ve en el cliente la columna total_saldo_spl de la tabla bundler

4. venta del token con el bundler: 

- cliente: el cliente tiene la opción de vender por porcentajes 25%, 50%, 75% o 100%. Sin embargo el puede personalizar el porcentaje. Una vez escriba el porcentaje que quiere enviar manda la petición de venta al orquestador
- orquestador: el orquestador recibe el porcentaje que quiere vender, toma el saldo total spl que en la tabla bundler y hace el calculo de cuanto se debe vender. luego toma esa cantidad y escoge las wallets de las que se va a sacar el saldo y que de la suma correspondiente.
- orquestador: el orquestador recopila la data de las wallets a vender y envía la solicitud de venta a la api usando el endpoint: /pump/advanced-sell
- orquestador: el orquestador actualiza los datos de la columna saldo_spl de la tabla child wallets de las wallets que se usaron para vender
- orquestador: envía al cliente la notificación de la venta exitosa
- cliente: el cliente puede hacer múltiples ventas de múltiples porcentajes, pero cuando decide vender el 100 % el flujo cambia un poco al final.
- orquestador: cuando el orquestador recibe que la venta será del 100% entonces vende todos los fondos de las wallets childs, actualiza las columnas saldo_spl de la tabla child wallets 
-  orquestador: al terminar las transferencias a las child wallets, se transfieren automáticamente todo el saldo sol de las child wallets a la wallet in app. El orquestador toma los datos para enviar al endpoint /sol/advanced-transfer. El orquestador va actualizando los saldos cuando recibe la respuesta de la api
- orqeustador: una vez termina las transferencias se actualiza el status del bundler a false

5. Tranferir sol a wallet del usuario: 

- cliente: el usuario puede transferir los fondos a su wallet con la que está registrado. ara eso le da click a transferir fondos de wallet in app.
- cleinte: el cliente manda el request al orquestador
-orquestador: el orquestador toma los datos de la base de datos para poder hacer la transferencia y usa el endpoint /sol/advanced-transfer para enviar la solicitud a la api
- orquestador: el orquestador actualiza los saldos en la base de datos y manda la notificación al usuario que la transferencia ha sido exitosa



-----------

Endpoints:

1. Crear wallet:

- /wallet/create: no requiere data 
- /wallet/{publicKey}/balance/sol: se requiere la publi key de la wallet en la tabla users columna wallet_in_app_public_key

2. crear bundler:

- /sol/advanced-transfer: fromPublicKey, toPublicKey, amountSol, privateKey. 
Transferencia wallet in app a wallet madres: fromPublicKey = tabla users columna wallet_in_app_public_key; toPublicKey = tabla mother_wallets columna public_key;  amountSol = cliente input usuario; privateKey = tabla users columna wallet_in_app_private_key

Transferencia wallets madre a child wallets: fromPublicKey = tabla mother_wallets columna public_key; toPublicKey = tabla child_wallets columna public_key;  amountSol = resultado de la función del orquestador siguiendo las 2 reglas; privateKey = tabla mother_wallets columna private_key

3. Creación y compra de tokens:

- /upload/pinata-image: fileName, contentType, imageBase64 = all from from value logo metadata

 
- /pump/advanced-create: creatorPublicKey = tabla users wallet_in_app_public_key, name = form value, symbol = form value, description = form value, imageUrl = from pinata api, devBuyAmount = form value, slippageBps = form value or set standar, privateKey = tabla users wallet_in_app_private_key 

- /pump/advanced-buy: buyerPublicKey = tabla child_wallets columna public_key; mintAddress = dirección del token, solAmount = tabla child_wallets columna saldo_sol; slippageBps = setea el default; privateKey = tabla child_wallets columna private_key

4. Vender tokens del bundler:

- /pump/advanced-sell: sellerPublicKey = tabla child_wallets columna public_key; mintAddress = direccion del token, tokenAmount = el determinado por el porcentaje ingresado por el usuario mas la función matemática del orquestador; slippageBps = seteado por default; privateKey = tabla child_wallets columna private_key

- /sol/advanced-transfer: fromPublicKey = tabla child columna public_key, toPublicKey = tabla users columna wallet_in_app_public_key, amountSol = tabla child_wallets columna balance_sol, privateKey = tabla child_wallets columna private_key

5. Tranferir sol a wallet del usuario:

- /sol/advanced-transfer: fromPublicKey = tabla users columna wallet_in_app_public_key, toPublicKey = tabla users columna  user_wallet, amountSol = tabla users columna balance_sol, privateKey = tabla users columna  wallet_in_app_private_key


------

api orchestador endpoints:

/.../create-wallet-in-app: se envía la wallet del usuario

/.../create-bundler: se envía wallet del usuario, saldo para el bundler

/.../create-and-buy-token-pumpFun: se envía formulario del token, y dev buy amount

/.../sell-created-token: envía porcentaje de venta

/.../transfer-to-owner-wallet: envía request para transferir de wallet in app a wallet del owner

-------

Cálculos transferencias: se debe dejar un saldo de 0.001 en la wallet in app cuando se transfiere y cuando se compra como devwallet. También se debe dejar en las ventas de las child wallets a menos que el usuario haya enviado para enviar el 100%.


-------------

sigue: crear los endpoints del orquestador
- organizar las fórmulas para mantener los fondos necesarios en las wallets
- crear el prompt para que traduzca y mejore la redacción y estandarice los valores de la base de datos y de las instrucciones
- escoger stack
- mantener las llamadas a la api de cristian con un enlace dummy
- crear la estructura del proyecto asignando los endpoint que se llamarán desde el cliente y el flujo que activan
- construir el orquestador
- construir el cliente


- crear token:
# Priority fee
$computeUnits = 200000         # 200k CUs
$microLamports = 10000         # 10k micro-lamports per CU (as per quicknode)

# Priority fee (pumpportal)

$priorityFeeSol = 0.0005  # in sol

# SlippageBPS
$slippageBps = 3000  # 30%

#Commitment

$commitment = "finalized"