/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

require('./auth.js');
require('./orders/orders.cloud.js');
require('./products/products.cloud.js');
require('./designers/designers.cloud.js');
require('./options.js');
require('./shipments/shipments.cloud.js');
require('./customers/customers.cloud.js');
require('./webhooks.js');
require('./returns/returns.cloud.js');


///////////////////////
//  BACKGROUND JOBS  //
///////////////////////

require('./jobs.js');
