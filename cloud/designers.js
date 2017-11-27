var _ = require('underscore');
var moment = require('moment-timezone');
var BigCommerce = require('node-bigcommerce');
var bugsnag = require("bugsnag");
var Mailgun = require('mailgun-js');

var Order = Parse.Object.extend('Order');
var Product = Parse.Object.extend('Product');
var Designer = Parse.Object.extend('Designer');
var Vendor = Parse.Object.extend('Vendor');
var VendorOrder = Parse.Object.extend('VendorOrder');
var VendorOrderVariant = Parse.Object.extend('VendorOrderVariant');
var ColorCode = Parse.Object.extend('ColorCode');
var StoneCode = Parse.Object.extend('StoneCode');
var SizeCode = Parse.Object.extend('SizeCode');
var MiscCode = Parse.Object.extend('MiscCode');

var { DesignersController } = require('./designers/designers.controller');

// CONFIG
bugsnag.register("a1f0b326d59e82256ebed9521d608bb2");
// Set up Bigcommerce API
var bigCommerce = new BigCommerce({
  logLevel: 'errors',
  clientId: process.env.BC_CLIENT_ID,
  secret: process.env.BC_CLIENT_SECRET,
  callback: 'https://audryrose.herokuapp.com/auth',
  responseType: 'json'
});
bigCommerce.config.accessToken = process.env.BC_ACCESS_TOKEN;
bigCommerce.config.storeHash = process.env.BC_STORE_HASH;
var mailgun = new Mailgun({apiKey: process.env.MAILGUN_API_KEY, domain: process.env.MAILGUN_DOMAIN});
const BIGCOMMERCE_BATCH_SIZE = 250;
const DESIGNERS_PER_PAGE = 50;
const PENDING_ORDER_STATUSES = [3, 7, 8, 9, 11, 12];
const isProduction = process.env.NODE_ENV == 'production';
const isDebug = process.env.DEBUG == 'true';

/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getDesigners", function(request, response) {
  logInfo('getDesigners cloud function --------------------------', true);
  var totalDesigners;
  var designers;
  var totalPages;
  var currentPage = (request.params.page) ? parseInt(request.params.page) : 1;
  var currentSort = (request.params.sort) ? request.params.sort : 'name-asc';
  var subpage = request.params.subpage ? request.params.subpage : 'all';
  var search = request.params.search ? request.params.search : null;

  var designersQuery = new Parse.Query(Designer);

  if (search) {
    var searchDesignerIdQuery = new Parse.Query(Designer);
    searchDesignerIdQuery.equalTo('designerId', parseFloat(search));
    designersQuery = searchDesignerIdQuery;

  } else {
    designersQuery = getDesignerSort(designersQuery, currentSort);
    switch (subpage) {
      case 'pending':
        designersQuery.equalTo('hasPendingVendorOrder', true);
        break;
      case 'sent':
        designersQuery.equalTo('hasSentVendorOrder', true);
      default:
        break;
    }
  }

  designersQuery.limit(10000);
  designersQuery.include('vendors');
  if (subpage !== 'completed') {
    designersQuery.include('vendors.vendorOrders');
    designersQuery.include('vendors.vendorOrders.vendorOrderVariants');
    designersQuery.include('vendors.vendorOrders.vendorOrderVariants.orderProducts');
    designersQuery.include('vendors.vendorOrders.vendorOrderVariants.variant');
    designersQuery.include('vendors.vendorOrders.vendorOrderVariants.resizeVariant');
  }

  Parse.Promise.as().then(function(count) {
    totalDesigners = count;
    totalPages = Math.ceil(totalDesigners / 10000);
    designersQuery.skip((currentPage - 1) * 10000);
    return designersQuery.find({useMasterKey:true});

  }).then(function(results) {
    designers = results;

    if (subpage === 'completed') {
      var vendorOrderQuery = new Parse.Query(VendorOrder);
      vendorOrderQuery.equalTo('receivedAll', true);
      vendorOrderQuery.include('vendor');
      vendorOrderQuery.include('vendorOrderVariants.orderProducts');
      vendorOrderQuery.include('vendorOrderVariants.variant');
      vendorOrderQuery.include('vendorOrderVariants.resizeVariant');
      vendorOrderQuery.descending('dateReceived');
      vendorOrderQuery.limit(1000);
      return vendorOrderQuery.find();
    } else {
      return true;
    }

  }).then(function(results) {
    var completedVendorOrders;
    if (results && results.length > 0) {
      completedVendorOrders = results;
    };
	  response.success({designers: designers, totalPages: totalPages, completedVendorOrders: completedVendorOrders});

  }, function(error) {
	  logError(error);
	  response.error(error.message);

  });
});

Parse.Cloud.define("loadDesigner", function(request, response) {
  logInfo('loadDesigner cloud function --------------------------', true);
  var designer = request.params.designer;
  var designerObj;
  var added = false;

  var designerQuery = new Parse.Query(Designer);
  designerQuery.equalTo('designerId', parseInt(designer.id));
  designerQuery.include('vendor');
  designerQuery.first().then(function(designerResult) {
    if (designerResult) {
      logInfo('designer ' + designerResult.get('designerId') + ' exists.');
      return createDesignerObject(designer, designerResult).save(null, {useMasterKey: true});
    } else {
      logInfo('designer ' + designer.id + ' is new.');
      added = true;
      return createDesignerObject(designer).save(null, {useMasterKey: true});
    }

  }).then(function(designerObject) {
    designerObj = designerObject;

    if (designerObject.has('vendors')) {
      logInfo('Designer has a vendor');
      return designerObject.get('vendors');

    } else if (designerObject.get('designerId') == 47) {
      logInfo('Designer is Antiques and has multiple vendors');
      return [];

    } else {
      logInfo('Designer is self vendor');
      var vendor = new Vendor();
      vendor.set('name', designerObject.get('name'));
      vendor.set('designers', [designerObject]);
      return [vendor];
    }

  }).then(function(vendors) {
      designerObj.set('vendors', vendors);
      return designerObj.save(null, {useMasterKey: true});

  }).then(function(result) {
    response.success({added: added});

  }, function(error) {
    logError(error);
    response.error(error.message);

	});
});

Parse.Cloud.define("saveVendor", function(request, response) {
  logInfo('saveVendor cloud function --------------------------', true);

  var startTime = moment();

  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 20000);

  var designerId = request.params.data.designerId;
  var vendorId = request.params.data.vendorId;
  var name = request.params.data.name;
  var firstName = request.params.data.firstName;
  var lastName = request.params.data.lastName;
  var email = request.params.data.email;
  var waitTime = parseFloat(request.params.data.waitTime);
  var designer;

  var designerQuery = new Parse.Query(Designer);
  designerQuery.equalTo('objectId', designerId);
  designerQuery.include('vendors');
  designerQuery.first().then(function(result) {
    designer = result;

    if (vendorId) {
      var vendorQuery = new Parse.Query(Vendor);
      vendorQuery.equalTo('objectId', vendorId);
      vendorQuery.include('designers');
      return vendorQuery.first();
    } else {
      var vendor = new Vendor();
      return vendor.save(null, {useMasterKey: true});
    }

  }).then(function(vendor) {

    if (name && name != '') {
      vendor.set('name', name);
    } else {
      vendor.unset('name');
    }
    if (firstName && firstName != '') {
      vendor.set('firstName', firstName);
    } else {
      vendor.unset('firstName');
    }
    if (lastName && lastName != '') {
      vendor.set('lastName', lastName);
    } else {
      vendor.unset('lastName');
    }
    if (email && email != '') {
      vendor.set('email', email);
    } else {
      vendor.unset('email');
    }
    if (waitTime && waitTime != '') {
      vendor.set('waitTime', waitTime);
    } else {
      vendor.unset('waitTime');
    }

    if (vendor.has('designers')) {
      vendor.addUnique('designers', designer);
    } else {
      vendor.set('designers', [designer]);
    }

    return vendor.save(null, {useMasterKey: true});


  }).then(function(vendorObject) {

    if (designer.has('vendors')) {
      designer.addUnique('vendors', vendorObject);
    } else {
      designer.set('vendors', [vendorObject]);
    }

    return designer.save(null, {useMasterKey: true});

  }).then(function(designerObject) {

    designerQuery = new Parse.Query(Designer);
    designerQuery.equalTo('objectId', designerId);
    designerQuery.include('vendors');
    designerQuery.include('vendors.vendorOrders');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants.orderProducts');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants.variant');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants.resizeVariant');
    return designerQuery.first();

  }).then(function(designerObject) {
    completed = true;
    logInfo('saveVendor completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    response.success({updatedDesigner: designerObject});

  }, function(error) {
		logError(error);
		response.error(error.message);

	});

});

Parse.Cloud.define("sendVendorOrder", function(request, response) {
  logInfo('sendVendorOrder cloud function --------------------------', true);

  var startTime = moment();

  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 28000);

  var designerId = request.params.data.designerId;
  var orderId = request.params.data.orderId;
  var message = request.params.data.message;
  var vendorOrder;
  var vendorOrderVariants;
  var vendor;
  var resizeVariants = [];
  var messageProductsText = message;
  var messageProductsHTML = message;
  var emailId;
  var productIds = [];
  var successMessage;
  var errors = [];

  var vendorOrderQuery = new Parse.Query(VendorOrder);
  vendorOrderQuery.equalTo('objectId', orderId);
  vendorOrderQuery.include('vendor');
  vendorOrderQuery.include('vendorOrderVariants');
  vendorOrderQuery.include('vendorOrderVariants.variant');
  vendorOrderQuery.include('vendorOrderVariants.resizeVariant');
  vendorOrderQuery.first().then(function(result) {
    if (result) {
      vendorOrder = result;
    } else {
      errors.push('Error sending order: vendor order not found.');
      response.success({errors: errors});
      return;
    }
    vendor = vendorOrder.get('vendor');
    vendorOrderVariants = vendorOrder.get('vendorOrderVariants');

    if (vendorOrder.get('orderedAll') == true) {
      errors.push('Error sending order: order already sent.');
      response.success({errors: errors});
      return;
    }

    _.each(vendorOrderVariants, function(vendorOrderVariant) {
      vendorOrderVariant.set('ordered', true);
      var variant = vendorOrderVariant.get('variant');
      if (productIds.indexOf(variant.get('productId') < 0)) productIds.push(variant.get('productId'));
    });
    messageProductsHTML = convertVendorOrderMessage(messageProductsHTML, vendorOrderVariants);

    if (!vendor.has('email')) {
      errors.push('Error sending order: ' + vendor.get('name') + ' needs an email address.');
      response.success({errors: errors});
      return;
    }
    var data = {
      from: 'orders@loveaudryrose.com',
      to: vendor.get('name') + ' <' + vendor.get('email') + '>',
      cc: isProduction ? 'Audry Rose <orders@loveaudryrose.com>' : 'Testing <hello@jeremyadam.com>',
      subject: 'Audry Rose Order ' + vendorOrder.get('vendorOrderNumber') + ' - ' + moment().tz('America/Los_Angeles').format('M.D.YY'),
      text: messageProductsText,
      html: messageProductsHTML
    }
    return mailgun.messages().send(data);

  }).then(function(body) {
    emailId = body.id;
    successMessage = 'Order ' + vendorOrder.get('vendorOrderNumber') + ' successfully sent to ' + vendor.get('email');
    logInfo(successMessage, true);

    return Parse.Object.saveAll(vendorOrderVariants, {useMasterKey: true});

  }).then(function() {
    logInfo(vendorOrderVariants.length + ' vendorOrderVariants saved');
    vendorOrder.set('orderedAll', true);
    vendorOrder.set('emailId', emailId);
    vendorOrder.set('dateOrdered', moment().toDate());
    return vendorOrder.save(null, {useMasterKey: true});

  }).then(function() {
    logInfo('vendorOrder saved');
    vendor.addUnique('vendorOrders', vendorOrder);
    return vendor.save(null, {useMasterKey: true});

  }).then(function() {
    logInfo('vendor saved');

  	logInfo(resizeVariants.length + ' resize variants to save');
  	return Parse.Object.saveAll(vendorOrderVariants, {useMasterKey: true});

	}).then(function() {
    logInfo(resizeVariants.length + ' resize variants saved');

    logInfo(productIds.length + ' product ids to save');

    var promise = Parse.Promise.as();

    _.each(productIds, function(productId) {
      logInfo('get product id: ' + productId);

      promise = promise.then(function() {
        var productQuery = new Parse.Query(Product);
        productQuery.equalTo('productId', productId);
        return productQuery.first();

      }).then(function(product) {
        return product.save(null, {useMasterKey: true});

      }).then(function() {
        return;

      }, function(error) {
    		logError(error);

    	});
  	});

  	return promise;

  }).then(function(result) {
    logInfo('products saved');

    var designerQuery = new Parse.Query(Designer);
    designerQuery.equalTo('objectId', designerId);
    designerQuery.include('vendors');
    designerQuery.include('vendors.vendorOrders');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants.variant');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants.resizeVariant');
    return designerQuery.first();

  }).then(function(designerObject) {
    logInfo('sendVendorOrder complete');
    completed = true;
    logInfo('sendVendorOrder completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    response.success({updatedDesigner: designerObject, successMessage: successMessage, errors: errors});

  }, function(error) {
		logError(error);
		response.error(error.message);

	});

});

Parse.Cloud.define("completeVendorOrder", (req, res) => {
  DesignersController.completeVendorOrder(req.params.vendorOrderNumber)
    .then(success => res.success(success))
    .catch(error => res.error(error));
});

Parse.Cloud.define("deleteProductFromVendorOrder", (req, res) => {
  var { productObjectId, vendorOrderNumber } = req.params;
  DesignersController.removeVendorOrderProduct(productObjectId, vendorOrderNumber)
    .then(success => res.success(success))
    .catch(error => res.error(error));
});

Parse.Cloud.define("getAllPendingVendorOrders", (req, res) => {
  var { page, sort, direction, ordersToSkip } = req.params;
  DesignersController.getAllPendingVendorOrders(page, sort, direction, ordersToSkip)
    .then(success => res.success(success))
    .catch(error => res.error(error));
});

Parse.Cloud.define("finishPendingVendorOrderProduct", (req, res) => {
  var { vendorOrderObjectId, vendorOrderVariantObjectId } = req.params;
  DesignersController.finishPendingVendorOrderProduct(vendorOrderObjectId, vendorOrderVariantObjectId)
    .then(success => res.success(success))
    .catch(error => res.error(error));
});

Parse.Cloud.define("getUpdatedDesigner", function(request, response) {
  var designerId = request.params.data.designerId;
  var updatedDesigner;
  var completedVendorOrders = [];

  var designerQuery = new Parse.Query(Designer);
  designerQuery.equalTo('objectId', designerId);
  designerQuery.include('vendors');
  designerQuery.include('vendors.vendorOrders');
  designerQuery.include('vendors.vendorOrders.vendorOrderVariants');
  designerQuery.include('vendors.vendorOrders.vendorOrderVariants.variant');
  designerQuery.include('vendors.vendorOrders.vendorOrderVariants.resizeVariant');
  designerQuery.first().then(function(designerObject) {
  	updatedDesigner = designerObject;

    var promise = Parse.Promise.as();

    _.each(updatedDesigner.get('vendors'), function(vendor) {

      promise = promise.then(function() {
        logInfo('get completed vendor orders for ' + vendor.id);
        var vendorOrderQuery = new Parse.Query(VendorOrder);
        vendorOrderQuery.equalTo('receivedAll', true);
        vendorOrderQuery.equalTo('vendor', vendor);
        vendorOrderQuery.include('vendor');
        vendorOrderQuery.include('vendorOrderVariants.orderProducts');
        vendorOrderQuery.include('vendorOrderVariants.variant');
        vendorOrderQuery.include('vendorOrderVariants.resizeVariant');
        vendorOrderQuery.descending('dateReceived');
        vendorOrderQuery.limit(20);
        return vendorOrderQuery.find();

      }).then(function(results) {
        logInfo(results.length + ' completed vendor order results for ' + vendor.id);
        completedVendorOrders = completedVendorOrders.concat(results);

      }, function(error) {
    		logError(error);

    	});
  	});

  	return promise;

  }).then(function() {
    response.success({updatedDesigner: updatedDesigner, completedVendorOrders: completedVendorOrders})
  }, function(error) {
    response.error(error);
  });
});

Parse.Cloud.define("getDesignerProducts", function(request, response) {
  logInfo('getDesignerProducts cloud function --------------------------', true);

  var startTime = moment();

  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 28000);

  var designerId = request.params.designerId;
  // var designer;
  var products;
  var responseData = {};

  logInfo('get products for designer ' + designerId);
  var designerQuery = new Parse.Query(Designer);
  designerQuery.equalTo('objectId', designerId);
  designerQuery.include('vendors');
  designerQuery.first().then(function(result) {
    var designer = result;
    var vendors = designer.get('vendors').map(function(vendor) {
      var vendorData = {
        objectId: vendor.id,
        name: vendor.get('name')
      };
      return vendorData;
    });
    responseData.designer = {
      objectId: designer.id,
      name: designer.get('name'),
      vendors: vendors
    };
    logInfo('designer ' + responseData.designer.name + ' found');

    var productsQuery = new Parse.Query(Product);
    productsQuery.equalTo('designer', designer);
    productsQuery.include('variants');
    productsQuery.include('vendor');
    productsQuery.ascending('productId');
    productsQuery.notEqualTo('isBundle', true);
    productsQuery.limit(999999);
    return productsQuery.find();

  }).then(function(results) {
    // responseData.products = results;
    responseData.products = results ? results.map(function(result) {
      var product = {
        productId: result.get('productId'),
        name: result.get('name'),
        vendor: result.get('vendor').toJSON()
      }
      if (result.has('variants')) {
        var variantsData = result.get('variants').map(function(variant) {
          return {
            objectId: variant.id,
            product_id: variant.get('product_id'),
            color_value: variant.get('color_value'),
            colorCode: variant.has('colorCode') ? variant.get('colorCode').toJSON() : null,
            gemstone_value: variant.get('gemstone_value'),
            stoneCode: variant.has('stoneCode') ? variant.get('stoneCode').toJSON() : null,
            size_value: variant.get('size_value'),
            sizeCode: variant.has('sizeCode') ? variant.get('sizeCode').toJSON() : null,
            length_value: variant.get('length_value'),
            letter_value: variant.get('letter_value'),
            singlepair_value: variant.get('singlepair_value'),
            miscCode: variant.has('miscCode') ? variant.get('miscCode').toJSON() : null,
            variantOptions: variant.get('variantOptions'),
            inventoryLevel: variant.get('inventoryLevel')
          };
        });
        product.variants = variantsData;
      }
      return product;
    } ) : [];
    logInfo(responseData.products.length + ' products found');

    var query = new Parse.Query(ColorCode);
    query.ascending('option_name');
    query.addAscending('value');
    query.limit(10000);
    return query.find();

  }).then(function(results) {
    responseData.colorCodes = results ? results.map(function(result) { return result.toJSON() } ) : [];
    logInfo(responseData.colorCodes.length + ' colorCodes loaded');

    var query = new Parse.Query(StoneCode);
    query.ascending('option_name');
    query.addAscending('value');
    query.limit(10000);
    return query.find();

  }).then(function(results) {
    responseData.stoneCodes = results ? results.map(function(result) { return result.toJSON() } ) : [];
    logInfo(responseData.stoneCodes.length + ' stoneCodes loaded');

    var query = new Parse.Query(SizeCode);
    query.ascending('option_name');
    query.addAscending('value');
    query.limit(10000);
    return query.find();

  }).then(function(results) {
    responseData.sizeCodes = results ? results.map(function(result) { return result.toJSON() } ) : [];
    logInfo(responseData.sizeCodes.length + ' sizeCodes loaded');

    var query = new Parse.Query(MiscCode);
    query.ascending('option_name');
    query.addAscending('value');
    query.limit(10000);
    return query.find();

  }).then(function(results) {
    responseData.miscCodes = results ? results.map(function(result) { return result.toJSON() } ) : [];
    logInfo(responseData.miscCodes.length + ' miscCodes loaded');

    logInfo('getDesignerProducts completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    completed = true;
    response.success(responseData);
  });
});

Parse.Cloud.define("addDesignerProductToVendorOrder", function(request, response) {
  logInfo('addDesignerProductToVendorOrder cloud function --------------------------', true);
  var startTime = moment();

  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 28000);

  var orders = request.params.orders;
  var designerId = request.params.designerId;
  var updatedDesigner;

  logInfo('addDesignerProductToVendorOrder ' + designerId + ' ------------------------');

  Parse.Cloud.run('addToVendorOrder', {orders: orders, getUpdatedProducts: false}).then(function(result) {

    logInfo('get updated designer');
    var designerQuery = new Parse.Query(Designer);
    designerQuery.equalTo('objectId', designerId);
    designerQuery.include('vendors.vendorOrders');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants.orderProducts');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants.variant');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants.resizeVariant');
    return designerQuery.first();

  }).then(function(result) {
    updatedDesigner = result;

    completed = true;
	  response.success({updatedDesigner: updatedDesigner});

    return Parse.Cloud.run('updateAwaitingInventoryQueue');

  }).then(function(result) {
    logInfo('addDesignerProductToVendorOrder completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    
  }, function(error) {
	  logError(error);
	  response.error(error.message);

  });
});


/////////////////////////
//  CLOUD JOBS         //
/////////////////////////

Parse.Cloud.job("saveVendorOrder", function(request, status) {
  logInfo('saveVendorOrder cloud function --------------------------', true);

  var startTime = moment();

  var designerId = request.params.data.designerId;
  var orderId = request.params.data.orderId;
  var variantsData = request.params.data.variantsData;
  var message = request.params.data.message;
  var vendorOrder;
  var vendorOrderVariants = [];
  var vendor;
  var numReceived = 0;
  var productIds = [];
  var updatedDesigner;
  var completedVendorOrders = [];

  logInfo('saveVendorOrder #' + orderId + ' ---------------------');

  var vendorOrderQuery = new Parse.Query(VendorOrder);
  vendorOrderQuery.equalTo('objectId', orderId);
  vendorOrderQuery.include('vendor');
  vendorOrderQuery.include('vendor.vendorOrders');
  vendorOrderQuery.first().then(function(result) {
    vendorOrder = result;
    vendor = vendorOrder.get('vendor');

    var promise = Parse.Promise.as();

    _.each(variantsData, function(variantData) {
      var variant;
      promise = promise.then(function() {
        var vendorOrderVariantQuery = new Parse.Query(VendorOrderVariant);
        vendorOrderVariantQuery.equalTo('objectId', variantData.objectId);
        vendorOrderVariantQuery.include('variant');
        vendorOrderVariantQuery.include('resizeVariant');
        vendorOrderVariantQuery.include('orderProducts');
        vendorOrderVariantQuery.include('orderProducts.vendorOrders');
        vendorOrderVariantQuery.include('orderProducts.awaitingInventory');
        vendorOrderVariantQuery.include('orderProducts.awaitingInventoryVendorOrders');
        return vendorOrderVariantQuery.first();

      }).then(function(vendorOrderVariant) {
        if (vendorOrderVariant) {
          variant = vendorOrderVariant.get('variant');
          var beforeInventory = variant.get('inventoryLevel');

          if (variantData.internalNotes != undefined) 
            vendorOrderVariant.set('internalNotes', variantData.internalNotes);

          logInfo('VendorOrderVariant found, set to ' + parseFloat(variantData.units) + ' units');
          if (variantData.units != undefined) vendorOrderVariant.set('units', parseFloat(variantData.units));
          if (variantData.notes != undefined) vendorOrderVariant.set('notes', variantData.notes);
          if (variantData.received != undefined) {
            logInfo('received:' + parseFloat(variantData.received))
            if (parseFloat(variantData.received) > vendorOrderVariant.get('received')) {
              var receivedDiff = parseFloat(variantData.received) - vendorOrderVariant.get('received');
                logInfo('Variant ' + variant.id + ' add ' + receivedDiff + ' to variant inventory', true);
                variant.increment('inventoryLevel', receivedDiff);
              logInfo('Set inventory for variant ' + variant.id + ' to ' + variant.get('inventoryLevel'), true);
            }
            vendorOrderVariant.set('received', parseFloat(variantData.received));
            if (vendorOrderVariant.get('received') >= vendorOrderVariant.get('units')) {
              vendorOrderVariant.set('done', true);
            }
          }
          var afterInventory = variant.get('inventoryLevel');
          var inventoryDiff = afterInventory - beforeInventory;
          if (inventoryDiff !== 0) logInfo('inventory change ' + (inventoryDiff >= 0 ? '+' : '-') + Math.abs(inventoryDiff) + ' for variant ' + variant.get('variantId'), true);
          return vendorOrderVariant.save(null, {useMasterKey:true});
        } else {
          logInfo('VendorOrderVariant not found');
          return;
        }

      }).then(function(vendorOrderVariant) {
        if (vendorOrderVariant && vendorOrderVariant.has('units')) {
          logInfo('VendorOrderVariant saved');
          logInfo('Variant has ' + vendorOrderVariant.get('units') + ' units');
          vendorOrderVariants.push(vendorOrderVariant);

          if (vendorOrderVariant.get('ordered') == true && vendorOrderVariant.get('received') >= vendorOrderVariant.get('units')) {
            numReceived++;
          }
        } else {
          logInfo('VendorOrderVariant not saved');
        }

        if (variant) {
          if (productIds.indexOf(variant.get('productId') < 0)) productIds.push(variant.get('productId'));
          return variant.save(null, {useMasterKey:true});
        } else {
          return;
        }
      }).then(function(result) {
        logInfo('ProductVariant saved');

      }, function(error) {
        logError(error);
      });
    });

    return promise;

  }, function(error) {
		logError(error);
		status.error(error.message);

	}).then(function() {
    vendorOrder.set('vendorOrderVariants', vendorOrderVariants);
    var totalWithUnits = 0;
    _.each(vendorOrderVariants, function(vendorOrderVariant) {
      if (vendorOrderVariant.get('units') > 0) totalWithUnits++;
    });
    logInfo('Total ' + vendorOrderVariants.length + ' vendorOrderVariants, ' + totalWithUnits + ' are requesting units');
    if (totalWithUnits > 0) {
      logInfo('Save changes to vendor order');
      vendorOrder.set('message', message);
      if (numReceived >= vendorOrderVariants.length) {
        vendorOrder.set('receivedAll', true);
        vendorOrder.set('dateReceived', moment().toDate());
        vendor.remove('vendorOrders', vendorOrder);
      }
      return vendorOrder.save(null, {useMasterKey:true});
    } else {
      logInfo('All variants removed, destroy the vendor order');
      vendor.remove('vendorOrders', vendorOrder);
      return destroyVendorOrder(vendorOrder);
    }

  }, function(error) {
		logError(error);
		status.error(error.message);

	}).then(function() {
    return vendor.save(null, {useMasterKey:true})

  }, function(error) {
		logError(error);
		status.error(error.message);

	}).then(function() {
    logInfo('vendor saved');

  //   var designerQuery = new Parse.Query(Designer);
  //   designerQuery.equalTo('objectId', designerId);
  //   designerQuery.include('vendors');
  //   designerQuery.include('vendors.vendorOrders');
  //   designerQuery.include('vendors.vendorOrders.vendorOrderVariants');
  //   designerQuery.include('vendors.vendorOrders.vendorOrderVariants.variant');
  //   designerQuery.include('vendors.vendorOrders.vendorOrderVariants.resizeVariant');
  //   return designerQuery.first();
  //
  // }, function(error) {
	// 	logError(error);
	// 	status.error(error.message);
  //
	// }).then(function(designerObject) {
  // 	updatedDesigner = designerObject;
  //
  //   var promise = Parse.Promise.as();
  //
  //   _.each(updatedDesigner.get('vendors'), function(vendor) {
  //
  //     promise = promise.then(function() {
  //       logInfo('get completed vendor orders for ' + vendor.id);
  //       var vendorOrderQuery = new Parse.Query(VendorOrder);
  //       vendorOrderQuery.equalTo('receivedAll', true);
  //       vendorOrderQuery.equalTo('vendor', vendor);
  //       vendorOrderQuery.include('vendor');
  //       vendorOrderQuery.include('vendorOrderVariants.orderProducts');
  //       vendorOrderQuery.include('vendorOrderVariants.variant');
  //       vendorOrderQuery.include('vendorOrderVariants.resizeVariant');
  //       vendorOrderQuery.descending('dateReceived');
  //       vendorOrderQuery.limit(20);
  //       return vendorOrderQuery.find();
  //
  //     }).then(function(results) {
  //       logInfo(results.length + ' completed vendor order results for ' + vendor.id);
  //       completedVendorOrders = completedVendorOrders.concat(results);
  //
  //     }, function(error) {
  //   		logError(error);
  //
  //   	});
  // 	});
  //
  // 	return promise;
  //
  // }).then(function() {
    // Send the cloud job status
    status.success('succeeded');

    logInfo(productIds.length + ' product ids to save');

    var promise = Parse.Promise.as();

    _.each(productIds, function(productId) {
      logInfo('get product id: ' + productId);

      promise = promise.then(function() {
        var productQuery = new Parse.Query(Product);
        productQuery.equalTo('productId', productId);
        return productQuery.first();

      }).then(function(product) {
        return product.save(null, {useMasterKey: true});

      }).then(function() {
        var ordersQuery = new Parse.Query(Order);
        ordersQuery.equalTo('productIds', productId);
        ordersQuery.containedIn('status_id', PENDING_ORDER_STATUSES);
        return ordersQuery.find();

      }).then(function(orders) {
        if (!orders) return true;

        var items = [];
    		_.each(orders, function(order) {
          items.push(order.get('orderId'));
        });

        if (items.length > 0) {
          return Parse.Cloud.run('addToReloadQueue', {objectClass: 'Order', items: items});
        } else {
          return true;
        }

      }, function(error) {
    		logError(error);

    	});
  	});

  	return promise;

  }, function(error) {
		logError(error);
		status.error(error.message);

	}).then(function(result) {
    logInfo('products saved');
    return Parse.Cloud.run('updateAwaitingInventoryQueue');

  }).then(function(result) {
    return Parse.Cloud.httpRequest({
      method: 'POST',
      url: process.env.SERVER_URL + '/jobs/processReloadQueue',
      headers: {
        'X-Parse-Application-Id': process.env.APP_ID,
        'X-Parse-Master-Key': process.env.MASTER_KEY
      }
    });

  }).then(function(result) {
  	logInfo('saveVendorOrder completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);

  }, function(error) {
		logError(error);
		status.error(error.message);

	});

});


/////////////////////////
//  BEFORE SAVE        //
/////////////////////////

Parse.Cloud.beforeSave("Vendor", function(request, response) {
  logInfo('Vendor beforeSave --------------------------', true);
  var vendor = request.object;
  var hasPendingVendorOrder = false;
  var hasSentVendorOrder = false;

  if (!vendor.has('abbreviation')) {
    var abbreviation = getAbbreviation(vendor.get('name'));
    vendor.set('abbreviation', abbreviation);
  }

  delay(10).then(function() {
    if (vendor.has('vendorOrders') && vendor.get('vendorOrders').length > 0) {
      return Parse.Object.fetchAll(vendor.get('vendorOrders'));
    } else {
      return [];
    }

  }).then(function(vendorOrders) {
    logInfo('vendor has ' + vendorOrders.length + ' vendor orders');
    _.each(vendorOrders, function(vendorOrder) {
      var orderedAll = vendorOrder.get('orderedAll');
      var receivedAll = vendorOrder.get('receivedAll');
      if (!orderedAll) {
        hasPendingVendorOrder = true;
      } else if (orderedAll && !receivedAll) {
        hasSentVendorOrder = true;
      }
    });
    logInfo('Vendor hasPendingVendorOrder: ' + hasPendingVendorOrder);
    logInfo('Vendor hasSentVendorOrder: ' + hasSentVendorOrder);

    if (vendor.has('designers') && vendor.get('designers').length > 0) {
      return Parse.Object.fetchAll(vendor.get('designers'));
    } else {
      return [];
    }

  }).then(function(designers) {
    logInfo('vendor has ' + designers.length + ' vendor orders');
    _.each(designers, function(designer) {
      designer.set('hasPendingVendorOrder', hasPendingVendorOrder);
      designer.set('hasSentVendorOrder', hasSentVendorOrder);
    });
    if (designers.length > 0) {
      return Parse.Object.saveAll(designers, {useMasterKey: true});
    } else {
      return [];
    }

  }).then(function() {
    logInfo('Vendor beforeSave complete');
    response.success();
  });

});

Parse.Cloud.beforeSave("VendorOrder", function(request, response) {
  logInfo('VendorOrder beforeSave --------------------------------');
  var vendorOrder = request.object;

  delay(10).then(function() {
    logInfo('go');
    // Remove any vendor order variants who have 0 units to order
    if (vendorOrder.has('vendorOrderVariants') && vendorOrder.get('vendorOrderVariants').length > 0) {
      logInfo('vendor order has ' + vendorOrder.get('vendorOrderVariants').length + ' vendor order variants to fetch');
      return Parse.Object.fetchAll(vendorOrder.get('vendorOrderVariants'));
    } else {
      return [];
    }

  }).then(function(vendorOrderVariants) {
    logInfo('vendor order has ' + vendorOrderVariants.length + ' vendor order variants');
    _.each(vendorOrderVariants, function(vendorOrderVariant) {
      if (vendorOrderVariant.has('units')) logInfo('vendor order variant has ' + vendorOrderVariant.get('units') + ' units');
      if (vendorOrderVariant.get('units') == 0) vendorOrder.remove('vendorOrderVariants', vendorOrderVariant);
    });

    // Create a unique vendor order number
    return vendorOrder.get('vendor').fetch();

  }).then(function(vendor){
    if (!vendorOrder.has('vendorOrderNumber')) {
      vendor.increment('vendorOrderCount', 1);
      var vendorOrderNumber = vendor.get('abbreviation') + vendor.get('vendorOrderCount');
      logInfo(vendorOrderNumber);
      vendorOrder.set('vendorOrderNumber', vendorOrderNumber);
      return vendor.save(null, {useMasterKey:true});

    } else {
      return false;
    }

  }).then(function(result) {
    logInfo('VendorOrder beforeSave complete');
    response.success();
  });
});


/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

var createDesignerObject = function(designerData, currentDesigner) {
  var designer = (currentDesigner) ? currentDesigner : new Designer();

  designer.set('designerId', parseInt(designerData.id));
  designer.set('name', designerData.name);
  if (!designer.get('abbreviation')) {
    var abbreviation = getAbbreviation(designerData.name);
    designer.set('abbreviation', abbreviation);
  }
  designer.set('image_file', designerData.image_file);

  return designer;
}

var getAbbreviation = function(name) {
  var abbreviation = name;
  abbreviation = abbreviation.toUpperCase();
  abbreviation = abbreviation.replace(/-/g, '');
  abbreviation = abbreviation.replace(/\./g, '');
  abbreviation = abbreviation.replace(/\+/g, '');
  abbreviation = abbreviation.replace(/\(|\)/g, '');
  abbreviation = abbreviation.replace(/ /g, '');
  return abbreviation.substring(0, 3);
}

var getDesignerSort = function(designersQuery, currentSort) {
  switch (currentSort) {
    case 'name-desc':
      designersQuery.descending("name");
      break;
    case 'name-asc':
      designersQuery.ascending("name");
      break;
    default:
      designersQuery.ascending("name");
      break;
  }
  return designersQuery;
}

var convertVendorOrderMessage = function(message, vendorOrderVariants) {
  var pTag = '<p style="box-sizing: border-box; font-family: \'Helvetica Neue\', Helvetica, Arial, sans-serif; font-weight: normal; margin: 0 0 10px 0;">';
  var thTag = '<th style="box-sizing: border-box; color: #999; font-family: \'Helvetica Neue\', Helvetica, Arial, sans-serif; font-size: 80%; margin: 0; padding: 8px; text-transform: uppercase; text-align:left;">';
  var thRightTag = '<th style="box-sizing: border-box; color: #999; font-family: \'Helvetica Neue\', Helvetica, Arial, sans-serif; font-size: 80%; margin: 0; padding: 8px; text-transform: uppercase; text-align:right;">';
  var trTag = '<tr style="box-sizing: border-box; font-family: \'Helvetica Neue\', Helvetica, Arial, sans-serif; margin: 0;">';
  var tdTag = '<td style="border-top: #eee 1px solid; box-sizing: border-box; font-family: \'Helvetica Neue\', Helvetica, Arial, sans-serif; margin: 0; padding: 8px; vertical-align: top; text-align:left;">';
  var tdRightTag = '<td style="border-top: #eee 1px solid; box-sizing: border-box; font-family: \'Helvetica Neue\', Helvetica, Arial, sans-serif; margin: 0; padding: 8px; vertical-align: top; text-align:right;">';

  message = message.replace(/(?:\r\n|\r\r|\n\n)/g, '</p>' + pTag);
  message = message.replace(/(?:\r|\n)/g, '<br/>');
  message = pTag + message;
  message += '</p>';

  var productsTable = '<table class="order" cellpadding="0" cellspacing="0" width="100%" style="margin: 20px 0; padding: 0; border: 1px solid #eee; border-radius: 5px;">';
  productsTable += '<thead>';
  productsTable += thTag + 'Style Name</th>';
  productsTable += thTag + 'Options</th>';
  productsTable += thTag + 'Notes</th>';
  productsTable += thRightTag + 'Units</th>';
  productsTable += '</thead>';
  productsTable += '<tbody>';
  _.each(vendorOrderVariants, function(vendorOrderVariant) {
    productsTable += trTag;
    var variant = vendorOrderVariant.get('variant');
    productsTable += tdTag;
    productsTable += variant.has('designerProductName') ? variant.get('designerProductName') : variant.get('productName');
    productsTable += '</td>';
    var optionsList = '';
		if (variant) {
  		if (variant.has('color_value')) optionsList += 'COLOR: ' + variant.get('color_value') + '<br/>';
  		if (variant.has('size_value')) optionsList += 'SIZE: ' + variant.get('size_value') + '<br/>';
  		if (variant.has('gemstone_value')) optionsList += 'STONE: ' + variant.get('gemstone_value') + '<br/>';
  		if (variant.has('length_value')) optionsList += 'LENGTH: ' + variant.get('length_value') + '<br/>';
  		if (variant.has('font_value')) optionsList += 'FONT: ' + variant.get('font_value') + '<br/>';
  		if (variant.has('letter_value')) optionsList += 'LETTER: ' + variant.get('letter_value') + '<br/>';
  		if (variant.has('singlepair_value')) optionsList += 'SINGLE/PAIR: ' + variant.get('singlepair_value') + '<br/>';
		}
    productsTable += tdTag + optionsList + '</td>';
    var notes = vendorOrderVariant.get('notes');
    productsTable += tdTag + notes + '</td>';
    productsTable += tdRightTag + vendorOrderVariant.get('units') + '</td>';
    productsTable += '</tr>';
  });
  productsTable += '</tbody></table>';

  message = message.replace('{{PRODUCTS}}', productsTable);

  return message;
}

var destroyVendorOrder = function(vendorOrder) {
  var vendorOrderVariants = vendorOrder.get('vendorOrderVariants');
  var orderProductsToSave = [];

  // Get all VendorOrderVariants and their OrderProducts
  _.each(vendorOrderVariants, function(vendorOrderVariant) {
    _.each(vendorOrderVariant.get('orderProducts'), function(orderProduct) {
      var addedToSave = false;
      _.each(orderProduct.get('vendorOrders'), function(orderProductVendorOrder) {
        if (orderProductVendorOrder.id == vendorOrder.id) {
          logInfo('removing vendorOrder from order product ' + orderProduct.get('orderProductId') + ' vendorOrders');
          orderProduct.remove('vendorOrders', orderProductVendorOrder);
          if (!addedToSave) orderProductsToSave.push(orderProduct);
          addedToSave = true;
        }
      });
      _.each(orderProduct.get('awaitingInventoryVendorOrders'), function(orderProductVendorOrder) {
        if (orderProductVendorOrder.id == vendorOrder.id) {
          logInfo('removing vendorOrder from order product ' + orderProduct.get('orderProductId') + ' awaitingInventoryVendorOrders');
          orderProduct.remove('awaitingInventoryVendorOrders', orderProductVendorOrder);
          if (!addedToSave) orderProductsToSave.push(orderProduct);
          addedToSave = true;
        }
      });
      _.each(orderProduct.get('awaitingInventory'), function(orderProductVendorOrderVariant) {
        if (orderProductVendorOrderVariant.id == vendorOrderVariant.id) {
          logInfo('removing vendorOrderVariant from order product ' + orderProduct.get('orderProductId') + ' awaitingInventory');
          orderProduct.remove('awaitingInventory', vendorOrderVariant);
          if (!addedToSave) orderProductsToSave.push(orderProduct);
          addedToSave = true;
        }
      });
    });
  });

  return Parse.Object.saveAll(orderProductsToSave, {useMasterKey: true}).then(function() {
    logInfo('order products saved');
    return Parse.Object.destroyAll(vendorOrderVariants);

  }).then(function() {
    logInfo('destroy vendorOrder ' + vendorOrder.get('vendorOrderNumber'));
    return vendorOrder.destroy();

  }, function(error) {
    logError(error);
    return error;

  });
}

var queryResultsToJSON = function(results) {
  var jsonArray = [];
  _.each(results, function(result) {
    jsonArray.push(result.toJSON());
  });
  return jsonArray;
}

var delay = function(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

var logInfo = function(i, alwaysLog) {
  if (!isProduction || isDebug || alwaysLog) console.info(i);
}

var logError = function(e) {
  console.error(e);
	if (isProduction) bugsnag.notify(e);
}
