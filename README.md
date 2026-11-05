# Doce Encontro — site, backend e publicação

## Iniciar localmente

Requer Node.js 22.5 ou mais recente. Dentro desta pasta, execute `node server.js` e abra http://localhost:4173.

O banco SQLite é criado automaticamente em `data/doce-encontro.sqlite`; ele guarda produtos, pedidos, itens dos pedidos e reservas.

## Painel

Acesse http://localhost:4173/admin ou use **Painel** no cabeçalho. A senha local vem do arquivo `.env`.

## Pix por pedido

O cliente recebe no WhatsApp um link privado de acompanhamento. Quando a equipe muda o pedido para **Aceito**, a página mostra o QR Pix com o valor e o Pix Copia e Cola. Depois de conferir o recebimento no banco, a equipe marca **Pago**. A confirmação do pagamento é manual.

## Publicação

O arquivo `render.yaml` prepara o app para um serviço Node/Docker chamado `doce-encontro`, com disco persistente para o SQLite. O disco exige um serviço pago no Render; o plano gratuito não preserva o SQLite após reinícios. O provedor pode não disponibilizar exatamente o subdomínio `doce-encontro.onrender.com` se esse nome já estiver ocupado.

Para publicar, a pasta `outputs` precisa estar em um repositório Git acessível pelo Render e conectado à sua conta. No deploy, configure `ADMIN_PASSWORD` e `PIX_KEY` como segredos do serviço. O `.env` e o banco local estão excluídos de Git/Docker para não serem publicados junto com o código.
