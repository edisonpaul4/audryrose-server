var _ = require('underscore');
var moment = require('moment-timezone');
var BigCommerce = require('node-bigcommerce');
var bugsnag = require("bugsnag");

var Product = Parse.Object.extend('Product');
var ProductVariant = Parse.Object.extend('ProductVariant');
var Category = Parse.Object.extend('Category');
var Classification = Parse.Object.extend('Classification');
var Department = Parse.Object.extend('Department');
var Designer = Parse.Object.extend('Designer');
var StyleNumber = Parse.Object.extend('StyleNumber');
var ColorCode = Parse.Object.extend('ColorCode');
var StoneCode = Parse.Object.extend('StoneCode');
var Order = Parse.Object.extend('Order');
var OrderProduct = Parse.Object.extend('OrderProduct');
var Vendor = Parse.Object.extend('Vendor');
var VendorOrder = Parse.Object.extend('VendorOrder');
var VendorOrderVariant = Parse.Object.extend('VendorOrderVariant');
var Resize = Parse.Object.extend('Resize');
var ResizeVariant = Parse.Object.extend('ResizeVariant');
var Metric = Parse.Object.extend('Metric');
var MetricGroup = Parse.Object.extend('MetricGroup');
var ReloadQueue = Parse.Object.extend('ReloadQueue');

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
const BIGCOMMERCE_BATCH_SIZE = 250;
const PRODUCTS_PER_PAGE = 25;
const yearLetters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"];
const PENDING_ORDER_STATUSES = [3, 7, 8, 9, 11, 12];
const isProduction = process.env.NODE_ENV == 'production';
const isDebug = process.env.DEBUG == 'true';

/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getProducts", function(request, response) {
  logInfo('getProducts cloud function --------------------------', true);
  var startTime = moment();
  
  var totalProducts;
  var totalPages;
  var tabCounts = {};
  var currentPage = (request.params.page) ? parseInt(request.params.page) : 1;
  var currentSort = (request.params.sort) ? request.params.sort : 'date-added-desc';
  var search = request.params.search ? request.params.search : null;
  var subpage = request.params.subpage ? request.params.subpage : 'in-stock';
  var filters = request.params.filters ? request.params.filters : null;
  
  var productsQuery = new Parse.Query(Product);
  
  if (search) {
    var addPlural = function(term) { return term + 's'; };
    var toLowerCase = function(w) { return w.toLowerCase(); };
    
    var regex = new RegExp(search.toLowerCase(), 'gi');
    var searchTerms = search.split(' ');
    searchTerms = _.map(searchTerms, toLowerCase);
    var pluralTerms = _.map(searchTerms, addPlural);
    searchTerms = searchTerms.concat(pluralTerms);
    
    var searchSkuQuery = new Parse.Query(Product);
    searchSkuQuery.matches('sku', regex);
    var searchNameQuery = new Parse.Query(Product);
    searchNameQuery.containedIn('search_terms', searchTerms);
    var searchProductIdQuery = new Parse.Query(Product);
    searchProductIdQuery.equalTo('productId', parseFloat(search)); 
    productsQuery = Parse.Query.or(searchSkuQuery, searchNameQuery, searchProductIdQuery);
    
  } else {
    
    if (filters.designer && filters.designer != 'all') {
      var designerQuery = new Parse.Query(Designer);
      designerQuery.equalTo('name', filters.designer);
      productsQuery.matchesQuery('designer', designerQuery);
    }
    
    if (filters.price && filters.price != 'all') {
      var price = filters.price.split('-');
      var min = parseFloat(price[0]);
      var max = price[1] ? parseFloat(price[1]) : null;
      productsQuery.greaterThanOrEqualTo('price', min);
      if (max) productsQuery.lessThanOrEqualTo('price', max);
    }
    
    if (filters.class && filters.class != 'all') {
      var classQuery = new Parse.Query(Classification);
      classQuery.equalTo('name', filters.class);
      productsQuery.matchesQuery('classification', classQuery);
    }
    
    productsQuery = getProductSort(productsQuery, currentSort);
    
    switch (subpage) {
      case 'in-stock':
        productsQuery.greaterThan('total_stock', 0);
        break;
      case 'need-to-order':
        productsQuery.lessThan('total_stock', 1);
        break;
      case 'waiting-to-receive':
        productsQuery.equalTo('hasVendorOrder', true);
        break;
      case 'being-resized':
        productsQuery.equalTo('hasResizeRequest', true);
        break;
      case 'all':
        break;
      default:
        break;
    }
  }
  productsQuery.include('variants');
  productsQuery.include('variants.colorCode');
  productsQuery.include('variants.stoneCode');
  productsQuery.include('resizes');
  productsQuery.include('resizes.resizeSourceVariant');
  productsQuery.include('resizes.orderProduct');
  productsQuery.include('department');
  productsQuery.include('classification');
  productsQuery.include('vendor');
  productsQuery.include('vendor.vendorOrders');
  productsQuery.include('vendor.vendorOrders.vendorOrderVariants');
  productsQuery.include('vendor.vendorOrders.vendorOrderVariants.orderProducts');
  productsQuery.include('bundleVariants');
  productsQuery.limit(PRODUCTS_PER_PAGE);
  
  var tabCountsQuery = new Parse.Query(MetricGroup);
  tabCountsQuery.equalTo('objectClass', 'Product');
  tabCountsQuery.equalTo('slug', 'tabCounts');
  tabCountsQuery.descending('createdAt');
  tabCountsQuery.include('metrics');
  
  tabCountsQuery.first().then(function(result) {
    var productsCount;
    if (result) {
      _.each(result.get('metrics'), function(metric) {
        switch (metric.get('slug')) {
          case 'inStock':
            tabCounts.inStock = metric.get('count');
            if (subpage == 'in-stock') productsCount = metric.get('count');
            break;
          case 'needToOrder':
            tabCounts.needToOrder = metric.get('count');
            if (subpage == 'need-to-order') productsCount = metric.get('count');
            break;
          case 'waitingToReceive':
            tabCounts.waitingToReceive = metric.get('count');
            if (subpage == 'waiting-to-receive') productsCount = metric.get('count');
            break;
          case 'beingResized':
            tabCounts.beingResized = metric.get('count');
            if (subpage == 'being-resized') productsCount = metric.get('count');
            break;
          case 'all':
            tabCounts.all = metric.get('count');
            if (subpage == 'all') productsCount = metric.get('count');
            break;
          default:
            break;
        }
      });
    }
    if (productsCount != undefined) {
      return productsCount;
    } else {
      return productsQuery.count();
    }
    
  }).then(function(count) {
    totalProducts = count;
    totalPages = Math.ceil(totalProducts / PRODUCTS_PER_PAGE);
    productsQuery.skip((currentPage - 1) * PRODUCTS_PER_PAGE);
    return productsQuery.find({useMasterKey:true});
    
  }).then(function(products) {
    logInfo('getProducts completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
	  response.success({products: products, totalPages: totalPages, totalProducts: totalProducts, tabCounts: tabCounts});
	  
  }, function(error) {
    logError(error);
	  response.error(error.message);
	  
  });
});

Parse.Cloud.define("updateProductTabCounts", function(request, response) {  
  logInfo('updateProductTabCounts cloud function --------------------------', true);
  var startTime = moment();
  
  var tabs = {};
  var metrics = [];
  
  var inStockQuery = new Parse.Query(Product);
  inStockQuery.greaterThan('total_stock', 0);
  
  var needToOrderQuery = new Parse.Query(Product);
  needToOrderQuery.lessThan('total_stock', 1);
  
  var waitingToReceiveQuery = new Parse.Query(Product);
  waitingToReceiveQuery.equalTo('hasVendorOrder', true);
  
  var beingResizedQuery = new Parse.Query(Product);
  beingResizedQuery.equalTo('hasResizeRequest', true);
  
  var allQuery = new Parse.Query(Product);
  
  inStockQuery.count().then(function(count) {
    tabs.inStock = count;
    metrics.push(createMetric('Product', 'inStock', 'In Stock', count));
    return needToOrderQuery.count();
    
  }).then(function(count) {
    tabs.needToOrder = count;
    metrics.push(createMetric('Product', 'needToOrder', 'Need To Order', count));
    return waitingToReceiveQuery.count();
    
  }).then(function(count) {
    tabs.waitingToReceive = count;
    metrics.push(createMetric('Product', 'waitingToReceive', 'Waiting To Receive', count));
    return beingResizedQuery.count();
    
  }).then(function(count) {
    tabs.beingResized = count;
    metrics.push(createMetric('Product', 'beingResized', 'Being Resized', count));
    return allQuery.count();
    
  }).then(function(count) {
    tabs.all = count;
    metrics.push(createMetric('Product', 'all', 'All', count));
    return Parse.Object.saveAll(metrics, {useMasterKey: true});
    
  }).then(function(results) {
    var metricGroup = new MetricGroup();
    metricGroup.set('objectClass', 'Product');
    metricGroup.set('slug', 'tabCounts');
    metricGroup.set('name', 'Tab Counts');
    metricGroup.set('metrics', results);
    return metricGroup.save(null, {useMasterKey: true});
    
  }).then(function(result) {
    
    logInfo('updateProductTabCounts completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
	  response.success(tabs);
	  
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  });
});

Parse.Cloud.define("getProduct", function(request, response) {
  logInfo('getProduct cloud function --------------------------', true);
  var startTime = moment();
  
  var productId = request.params.productId;
  logInfo('getProduct for ' + productId);
  
  var productQuery = new Parse.Query(Product);
  productQuery.equalTo('productId', parseFloat(productId)); 
  productQuery.include('variants');
  productQuery.include('variants.colorCode');
  productQuery.include('variants.stoneCode');
  productQuery.include('resizes');
  productQuery.include('resizes.resizeSourceVariant');
  productQuery.include('resizes.orderProduct');
  productQuery.include('department');
  productQuery.include('classification');
  productQuery.include('vendor');
  productQuery.include('vendor.vendorOrders');
  productQuery.include('vendor.vendorOrders.vendorOrderVariants');
  productQuery.include('vendor.vendorOrders.vendorOrderVariants.orderProducts');
  productQuery.include('bundleVariants');

  productQuery.first().then(function(product) {
    logInfo('getProduct completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
	  response.success({product: product});
	  
  }, function(error) {
    logError(error);
	  response.error(error.message);
	  
  });
});

Parse.Cloud.define("getProductFilters", function(request, response) {  
  logInfo('getProductFilters cloud function --------------------------', true);
  var startTime = moment();
  
  var designers = [];
  var designersQuery = new Parse.Query(Designer);
  designersQuery.ascending('name');
  designersQuery.limit(10000);
  
  var classes = [];
  var classesQuery = new Parse.Query(Classification);
  classesQuery.ascending('name');
  classesQuery.limit(10000);
  
  designersQuery.find({useMasterKey:true}).then(function(result) {
    designers = result;
    return classesQuery.find({useMasterKey:true});
    
  }).then(function(result) {
    classes = result;
    logInfo('getProductFilters completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
	  response.success({designers: designers, classes: classes});
	  
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  });
});

Parse.Cloud.define("loadProduct", function(request, response) {
  var startTime = moment();
  
  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 20000); 
  
  var productId = parseFloat(request.params.productId);
  logInfo('loadProduct cloud function ' + productId + ' --------------------------', true);
  var product;
  var added = false;
  
  var classes = [];
  var departments = [];
  var designers = [];
//   var updatedClassification;
  
  var classesQuery = new Parse.Query(Classification);
  classesQuery.limit(10000);
  classesQuery.find().then(function(result) {
    classes = result;
    
    var departmentsQuery = new Parse.Query(Department);
    departmentsQuery.limit(10000);
    return departmentsQuery.find();
    
  }, function(error) {
		logError(error);
		response.error(error);
		
	}).then(function(result) {
    departments = result;
    
    var designersQuery = new Parse.Query(Designer);
    designersQuery.limit(10000);
    return designersQuery.find();
    
  }, function(error) {
		logError(error);
		response.error(error);
		
	}).then(function(result) {
    designers = result;
    
    var request = '/products/' + productId;
    logInfo(request)
    return bigCommerce.get(request);
    
  }, function(error) {
		logError(error);
		response.error(error);
		
	}).then(function(result) {
    product = result;
    
    var productQuery = new Parse.Query(Product);
    productQuery.equalTo('productId', productId);
    productQuery.include('department');
    productQuery.include('designer');
    productQuery.include('vendor');
    productQuery.include('classification');
    return productQuery.first();
    
  }, function(error) {
		logError(error);
		response.error(error);
		
	}).then(function(productResult) {
    if (productResult) {
      logInfo('Product ' + productResult.get('productId') + ' exists.');
      return createProductObject(product, classes, departments, designers, productResult);
    } else {
      logInfo('Product ' + productId + ' is new.');
      added = true;
      return createProductObject(product, classes, departments, designers);
    }
    
  }, function(error) {
		logError(error);
		response.error(error);
		
	}).then(function(productObject) {
    return productObject.save(null, {useMasterKey: true});
    
  }, function(error) {
		logError(error);
		response.error(error);
		
	}).then(function(result) {
  	return Parse.Cloud.run('updateAwaitingInventoryQueue');
  	
	}).then(function(result) {
  	logInfo('loadProduct completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
  	completed = true;
    response.success({added: added});
    
  }, function(error) {
		logError(error);
		response.error(error);
		
	});
});

Parse.Cloud.define("loadProductVariants", function(request, response) {
  var startTime = moment();
  
  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 20000); 
    
  var totalVariantsAdded = 0;
  var product;
  var bcProduct;
  var bcProductRules;
  var bcProductOptions;
  var allVariantIds = [];
  var allVariants = [];
  var productId = request.params.productId;
  var productQuery = new Parse.Query(Product);
  productQuery.equalTo('productId', parseInt(productId));
  productQuery.include('department');
  productQuery.include('classification');
  productQuery.include('designer');
  productQuery.include('bundleVariants');
  
  logInfo('loadProductVariants cloud function product: ' + productId + ' --------------------------', true);
  
  productQuery.first().then(function(result) {
    product = result;
    var productRequest = '/products/' + productId;
    return bigCommerce.get(productRequest);
    
  }).then(function(res) {
    bcProduct = res;
    if (!bcProduct) response.error('Product ' + productId + ' not found in Bigcommerce.');
    return delay(500);
    
  }).then(function(res) {
    var rulesRequest = '/products/' + productId + '/rules';
    return bigCommerce.get(rulesRequest);
  
  }, function(error) {
  	logInfo('Error loading product ' + productId + ' from Bigcommerce.' + JSON.stringify(error), true);
  	response.success(totalVariantsAdded);
		
  }).then(function(res) {
    bcProductRules = res;
    return delay(500);
    
  }).then(function(res) {
    if (bcProduct && bcProduct.option_set) {
      var optionSetsRequest = '/optionsets/' + bcProduct.option_set_id + '/options';
      return bigCommerce.get(optionSetsRequest);
    } else {
      return;
    }
  
  }, function(error) {
  	logError(error);
		response.error(error.message);
		
  }).then(function(res) {
    bcProductOptions = res;
    
    logInfo('loadProductVariants bigcommerce product: ' + productId + ' completed:' + moment().diff(startTime, 'seconds') + ' seconds');
    
    var allPromises = [];
    var promise = Parse.Promise.as();
    
    ////////////////////////////////////////////////////////
    // If bundle, get all variants of child products
    ////////////////////////////////////////////////////////
    if (product.has('isBundle') && product.get('isBundle') == true) {
      logInfo('Product is a bundle');
      if (product.has('bundleVariants')) {
        logInfo('Product has bundle variants');
        _.each(product.get('bundleVariants'), function(bundleVariant) {
          promise = promise.then(function() {
            var bundleVariantProductId = bundleVariant.get('productId');
            var productQuery = new Parse.Query(Product);
            productQuery.equalTo('productId', bundleVariantProductId);
            productQuery.include('variants');
            return productQuery.first();
              
          }).then(function(result) {
            var productVariants = result.get('variants');
            _.each(productVariants, function(productVariant) {
              if (allVariantIds.indexOf(productVariant.id) < 0) {
                allVariantIds.push(productVariant.id);
                allVariants.push(productVariant);
              }
              return productVariant;
            });
            return;
            
          });
        });
        allPromises.push(promise);
        
      } else {
        logInfo('Product does not have bundle variants');
        return true;
      }
    
    
    ////////////////////////////////////////////////////////
    // Create a single variant if product has no options
    ////////////////////////////////////////////////////////
    } else if (!bcProductOptions) {
      var variantId = productId.toString();
      promise = promise.then(function() {
        var variantQuery = new Parse.Query(ProductVariant);
        variantQuery.equalTo('variantId', variantId);
        return variantQuery.first();
          
      }).then(function(variantResult) {
        if (variantResult) {
          logInfo('Variant ' + variantResult.get('variantId') + ' exists.');
          isNew = false;
          return createProductVariantObject(product, variantId, null, variantResult);
        } else {
          logInfo('Variant ' + variantId + ' is new.');
          totalVariantsAdded++;
          return createProductVariantObject(product, variantId, null);
        }
        
      }, function(error) {
      	logError(error);
    		response.error(error.message);
      }).then(function(variantObject) {
        return variantObject.save(null, {useMasterKey: true});
        
      }, function(error) {
      	logError(error);
    		response.error(error.message);
      }).then(function(variantObject) {
        allVariants.push(variantObject);
        return variantObject;
        
      }, function(error) {
    		logError(error);
    		return error;
  			
  		});
      allPromises.push(promise);
    
    ////////////////////////////////////////////////////////
    // Create multiple variants if product has options
    ////////////////////////////////////////////////////////
    } else {
      
      // Create an array of all the option values
      var values = [];
      _.each(bcProductOptions, function(option) {
        var valueSet = [];
        _.each(option.values, function(optionValue) {
          optionValue.option_set_id = option.option_set_id;
          optionValue.option_id = option.option_id;
          optionValue.display_name = option.display_name;
          optionValue.value_sort_order = optionValue.sort_order;
          optionValue.sort_order = option.sort_order;
          optionValue.is_required = option.is_required;
          var priceAdjustment = optionPriceAdjustment(optionValue.option_id, optionValue.option_value_id, bcProductRules);
          if (priceAdjustment) {
            logInfo('save price adjustment');
            optionValue.adjuster = priceAdjustment.adjuster;
            optionValue.adjuster_value = priceAdjustment.adjuster_value;
          }
          var isEnabled = optionIsPurchasingEnabled(optionValue.option_id, optionValue.option_value_id, bcProductRules);
          if (isEnabled) valueSet.push(optionValue);
        });
        if (valueSet.length) values.push(valueSet);
      });
      
      logInfo('loadProductVariants option values product: ' + productId + ' completed:' + moment().diff(startTime, 'seconds') + ' seconds');
      
      // Get all possible combinations of option value ids
      var valueIds = [];
      _.each(values, function(value) {
        var valueIdsSet = [];
        _.each(value, function(valueSet) {
          if (valueIdsSet.indexOf(valueSet.option_value_id) < 1) valueIdsSet.push(valueSet.option_value_id);
        });
        valueIds.push(valueIdsSet);
      });
      var variants = allCombinations(valueIds);
      
      logInfo('loadProductVariants all combinations product: ' + productId + ' completed:' + moment().diff(startTime, 'seconds') + ' seconds');
      
      // Populate and save the variants
      _.each(variants, function(valueIds) {
        if (!valueIds.length) valueIds = [valueIds];
        var variantOptions = [];
        var variantId = productId.toString();

        // Check if variant exists
        promise = promise.then(function() {
          _.each(valueIds, function(valueId) {
            // Find the options data based on variantId
            _.each(values, function(valueSet) {
              
              _.each(valueSet, function(value) {
                if (valueId == value.option_value_id) {
                  variantOptions.push(value);
                  variantId += '-' + value.option_value_id;
                }
              });
            });
          });
          var variantQuery = new Parse.Query(ProductVariant);
          variantQuery.equalTo('variantId', variantId);
          return variantQuery.first();
            
        }).then(function(variantResult) {
          if (variantResult) {
            logInfo('Variant ' + variantResult.get('variantId') + ' exists.');
            return createProductVariantObject(product, variantId, variantOptions, variantResult);
          } else {
            logInfo('Variant ' + variantId + ' is new.');
            totalVariantsAdded++;
            return createProductVariantObject(product, variantId, variantOptions);
          }
          
        }, function(error) {
        	logError(error);
      		response.error(error.message);
        }).then(function(variantObject) {
          return variantObject.save(null, {useMasterKey: true});
          
        }, function(error) {
        	logError(error);
      		response.error(error.message);
        }).then(function(variantObject) {
          logInfo('loadProductVariants variantObject saved product: ' + productId + ' completed:' + moment().diff(startTime, 'seconds') + ' seconds');
          allVariants.push(variantObject);
          return variantObject;
          
        }, function(error) {
      		logError(error);
      		return error;
    			
    		});
    		allPromises.push(promise);
      });
      
      
      
//       return promise;
    }
    return Parse.Promise.when(allPromises);
    
  }, function(error) {
  	logError(error);
		response.error(error.message);
  }).then(function() {
    logInfo('loadProductVariants create options product: ' + productId + ' completed:' + moment().diff(startTime, 'seconds') + ' seconds');
		var now = new Date();
		product.set("variantsUpdatedAt", now);
		logInfo('set ' + allVariants.length + ' total variants to product');
    product.set('variants', allVariants);
    return product.save(null, {useMasterKey: true});
    
  }, function(error) {
  	logError(error);
		response.error(error.message);
  }).then(function(savedProduct) {
    logInfo('loadProductVariants completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    completed = true;
    response.success(totalVariantsAdded);
    
  }, function(error) {
  	logError(error);
		response.error(error.message);
  });
});

Parse.Cloud.define("reloadProduct", function(request, response) {
  logInfo('reloadProduct cloud function --------------------------', true);
  var startTime = moment();
  
  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 20000); 
  
  var productId = parseInt(request.params.productId);
  var updatedProduct;
  var bcProduct;

  Parse.Cloud.run('loadProduct', {productId: productId}).then(function(result) {
    return Parse.Cloud.run('loadProductVariants', {productId: productId});
    
  }).then(function(result) {
    var productsQuery = new Parse.Query(Product);
    productsQuery.equalTo("productId", productId);
    productsQuery.include('variants');
    productsQuery.include('variants.colorCode');
    productsQuery.include('variants.stoneCode');
    productsQuery.include('resizes');
    productsQuery.include('resizes.resizeSourceVariant');
    productsQuery.include('resizes.orderProduct');
    productsQuery.include('department');
    productsQuery.include('classification');
    productsQuery.include('vendor');
    productsQuery.include('vendor.vendorOrders');
    productsQuery.include('vendor.vendorOrders.vendorOrderVariants');
    productsQuery.include('vendor.vendorOrders.vendorOrderVariants.orderProducts');
    productsQuery.include('bundleVariants');
    return productsQuery.first();
    
  }).then(function(result) {
    updatedProduct = result;
    return Parse.Cloud.run('updateProductTabCounts');
    
  }).then(function(result) {
    tabCounts = result;
    logInfo('reloadProduct completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    completed = true;
	  response.success({updatedProduct: updatedProduct, tabCounts: tabCounts});
	  
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  });
});

Parse.Cloud.define("saveProduct", function(request, response) {
  logInfo('saveProduct cloud function --------------------------', true);
  var startTime = moment();
  
  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 20000);
    
  var productId = parseInt(request.params.data.productId);
  var isActive = request.params.data.isActive !== undefined ? (request.params.data.isActive == true || request.params.data.isActive == 'true') ? true : false : undefined;
  var vendorId = request.params.data.vendorId;
  var isBundle = request.params.data.isBundle !== undefined ? (request.params.data.isBundle == true || request.params.data.isBundle == 'true') ? true : false : undefined;
  var designerProductName = request.params.data.designerProductName;
  var product;
  var vendor;
  var updatedProduct;
  var variants;
  
  logInfo('saveProduct ' + productId + ' ------------------------')
  if (isActive !== undefined) logInfo('set isActive: ' + isActive);
  if (vendorId !== undefined) logInfo('set vendorId: ' + vendorId);
  if (isBundle !== undefined) logInfo('set isBundle: ' + isBundle);
  if (designerProductName !== undefined) logInfo('set designerProductName: ' + designerProductName);
  
  var productQuery = new Parse.Query(Product);
  productQuery.equalTo('productId', productId);
  productQuery.include('variants');
  productQuery.first().then(function(productResult) {
    product = productResult;
    variants = product.get('variants');
    if (product) {
      if (isActive !== undefined) product.set('is_active', isActive);
      if (isBundle !== undefined) product.set('isBundle', isBundle);
      if (designerProductName !== undefined) {
        product.set('designerProductName', designerProductName);
        if (variants.length > 0) {
          _.each(variants, function(variant) {
            variant.set('designerProductName', designerProductName);
          });
        }
      }
    } else {
      logError(error);
      response.error(error.message);
    }
    
    if (vendorId !== undefined) {
      var vendorQuery = new Parse.Query(Vendor);
      vendorQuery.equalTo('objectId', vendorId);
      return vendorQuery.first();
    } else {
      return;
    }
    
  }).then(function(vendorResult) {
    if (vendorResult) {
      vendor = vendorResult;
      product.set('vendor', vendor);
    }
    return product.save(null, {useMasterKey: true});
    
  }).then(function(productObject) {
    if (variants.length <= 0) return true;
    return Parse.Object.saveAll(variants, {useMasterKey: true});
    
  }).then(function() {
    var productQuery = new Parse.Query(Product);
    productQuery.equalTo("productId", productId);
    productQuery.include('variants');
    productQuery.include('variants.colorCode');
    productQuery.include('variants.stoneCode');
    productQuery.include('resizes');
    productQuery.include('resizes.resizeSourceVariant');
    productQuery.include('resizes.orderProduct');
    productQuery.include('department');
    productQuery.include('classification');
    productQuery.include('vendor');
    productQuery.include('vendor.vendorOrders');
    productQuery.include('vendor.vendorOrders.vendorOrderVariants');
    productQuery.include('vendor.vendorOrders.vendorOrderVariants.orderProducts');
    productQuery.include('bundleVariants');
    return productQuery.first();
    
  }).then(function(result) {
    updatedProduct = result;
    return Parse.Cloud.run('updateProductTabCounts');
    
  }).then(function(result) {
    tabCounts = result;
    logInfo('saveProduct completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    completed = true;
	  response.success({updatedProduct: updatedProduct, tabCounts: tabCounts});
    
  }, function(error) {
		logError(error);
		response.error(error.message);
		
	});
  
});

Parse.Cloud.define("saveVariants", function(request, response) {
  logInfo('saveVariants cloud function --------------------------', true);
  var startTime = moment();
  
  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 20000);  
  
  var variants = request.params.variants;  
  if (variants.length == 0) response.success();
  var updatedVariants = [];
  var updatedProducts = [];
  var productIds = [];
  var tabCounts;
  
  var productsQuery = new Parse.Query(Product);
  productsQuery.count().then(function(count) {
    
    logInfo(variants.length + ' variants ids to save');
    
    var promise = Parse.Promise.as();
    
    _.each(variants, function(variant) {
      var objectId = variant.objectId;
      var inventory = variant.inventory;
      promise = promise.then(function() {
        logInfo('saving variant: ' + objectId);
        
        var variantQuery = new Parse.Query(ProductVariant);
        variantQuery.equalTo('objectId', objectId);
        return variantQuery.first();
        
      }).then(function(variant) {
        if (variant) {
          logInfo('variant found');
          if (inventory) {
            variant.set('inventoryLevel', parseInt(inventory));
          } else {
            variant.set('inventoryLevel', 0);
          }
          logInfo('Set inventory for variant ' + variant.get('variantId') + ' to ' + variant.get('inventoryLevel'), true);
          return variant.save(null, {useMasterKey: true});
        } else {
          logError(error);
          response.error(error.message);
        }
        
      }).then(function(variantObject) {
        logInfo('saved: ' + variantObject.get('variantId'));
        updatedVariants.push(variantObject);
        if (productIds.indexOf(variantObject.get('productId')) < 0) productIds.push(variantObject.get('productId'));
        return true;
        
      }, function(error) {
    		logError(error);
    		response.error(error.message);
    		
    	});
    	
  	});
  	return promise;
  	
	}).then(function() {
  	
  	logInfo(productIds.length + ' product ids to save');
  	
    var promise = Parse.Promise.as();
    
    _.each(productIds, function(productId) {
      logInfo('save product id: ' + productId);
      
      promise = promise.then(function() {
        
        var productQuery = new Parse.Query(Product);
        productQuery.equalTo('productId', productId);
        productQuery.include('variants');
        productQuery.include('variants.colorCode');
        productQuery.include('variants.stoneCode');
        productQuery.include('resizes');
        productQuery.include('resizes.resizeSourceVariant');
        productQuery.include('resizes.orderProduct');
        productQuery.include('department');
        productQuery.include('classification');
        productQuery.include('vendor');
        productQuery.include('vendor.vendorOrders');
        productQuery.include('vendor.vendorOrders.vendorOrderVariants');
        productQuery.include('vendor.vendorOrders.vendorOrderVariants.orderProducts');
        productQuery.include('bundleVariants');
        return productQuery.first();
      
      }).then(function(product) {
        return product.save(null, {useMasterKey: true});
        
      }).then(function(productObject) {
        logInfo(productId + ' saved');
        updatedProducts.push(productObject);
        return true;
        
      }, function(error) {
    		logError(error);
    		response.error(error.message);
    		
    	});
  	});
  	
  	return promise;
  	
  }).then(function(result) {
    logInfo('get product tab counts');
    
    return Parse.Cloud.run('updateProductTabCounts');
    
  }).then(function(result) {
    logInfo('success');
    tabCounts = result;
    logInfo('saveVariants completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    completed = true;
	  response.success({updatedProducts: updatedProducts, updatedVariants: updatedVariants, tabCounts: tabCounts});
    
	});
  
});

Parse.Cloud.define("addToVendorOrder", function(request, response) {
  logInfo('addToVendorOrder cloud function --------------------------', true);
  var startTime = moment();
  
  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 20000);
  
  var orders = request.params.orders;
  var orderId = parseFloat(request.params.orderId);
  var updatedVariants = [];
  var updatedProductIds = [];
  var updatedProducts = [];
  var vendorOrders = [];
  var productIds = [];
  var tabCounts;
  
  var query = new Parse.Query(Product);
  query.count().then(function() {
    
    logInfo(vendorOrders.length + ' orders to add');
    
    var promise = Parse.Promise.as();
    
    _.each(orders, function(order) {
      var resize = (order.resize == true || order.resize == 'true') ? true : false;
      var orderProductId = order.orderProductId ? parseFloat(order.orderProductId) : null;
      var variantId = order.variant;
      var resizeVariantId = order.resizeVariant;
      var vendorId = order.vendor;
      var units = parseFloat(order.units);
      var notes = order.notes;
      var variant;
      var vendor;
      var vendorOrder;
      var vendorOrderVariant;
      var isNewOrder = false;
      var orderProduct;
      
      promise = promise.then(function() {
        
        if (orderProductId) {
          logInfo('get order product: ' + orderProductId);
          var orderProductQuery = new Parse.Query(OrderProduct);
          orderProductQuery.equalTo('orderProductId', orderProductId);
          return orderProductQuery.first();
        } else {
          logInfo('no order products');
          return false;
        }
        
      }).then(function(result) {
        if (result) orderProduct = result;
        
        logInfo('get variant: ' + variantId);
        // Get the requested ProductVariant
        var variantQuery = new Parse.Query(ProductVariant);
        variantQuery.equalTo('objectId', variantId);
        return variantQuery.first();
        
      }).then(function(result) {
        if (result) {
          logInfo('ProductVariant found');
          variant = result;
          updatedVariants.push(variant);
          if (productIds.indexOf(variant.get('productId') < 0)) productIds.push(variant.get('productId'));
          
          // Get the requested Vendor
          var vendorQuery = new Parse.Query(Vendor);
          vendorQuery.equalTo('objectId', vendorId);
          return vendorQuery.first();
          
        } else {
          logError('Product variant not found');
          response.error('Product variant not found');
        }
        
      }).then(function(result) {
        if (result) {
          logInfo('Vendor found');
          vendor = result;
          
          // Find a pending VendorOrderVariant
          var vendorOrderVariantQuery = new Parse.Query(VendorOrderVariant);
          vendorOrderVariantQuery.equalTo('variant', variant);
          vendorOrderVariantQuery.equalTo('ordered', false);
          vendorOrderVariantQuery.equalTo('done', false);
          if (orderProduct) vendorOrderVariantQuery.equalTo('orderProducts', orderProduct);
          return vendorOrderVariantQuery.first();
          
        } else {
          logError('Vendor not found');
          response.error('Vendor not found');
        }
        
      }).then(function(result) {
        if (result) {
          logInfo('VendorOrderVariant found, adjust number of units');
          vendorOrderVariant = result;
          vendorOrderVariant.increment('units', units);
          if (vendorOrderVariant.has('notes') && vendorOrderVariant.get('notes') != '') {
            var updatedNotes = vendorOrderVariant.get('notes') + '<br/>' + notes;
            vendorOrderVariant.set('notes', updatedNotes);
          } else {
            vendorOrderVariant.set('notes', notes);
          }
           
        } else {
          logInfo('VendorOrderVariant is new');
          vendorOrderVariant = new VendorOrderVariant();
          vendorOrderVariant.set('variant', variant);
          vendorOrderVariant.set('units', units);
          vendorOrderVariant.set('notes', notes);
          vendorOrderVariant.set('ordered', false);
          vendorOrderVariant.set('received', 0);
          vendorOrderVariant.set('done', false);
          
        }
        if (orderProduct) vendorOrderVariant.addUnique('orderProducts', orderProduct);
        return vendorOrderVariant.save(null, {useMasterKey:true});
        
      }).then(function(result) {
        logInfo('VendorOrderVariant saved');
        
        // Find a VendorOrder containing the VendorOrderVariant
        var vendorOrderQuery = new Parse.Query(VendorOrder);
        vendorOrderQuery.equalTo('vendor', vendor);
        vendorOrderQuery.equalTo('orderedAll', false);
        vendorOrderQuery.equalTo('receivedAll', false);
        return vendorOrderQuery.first();
        
      }).then(function(result) {
        
        if (result) {
          logInfo('VendorOrder found, add VendorOrderVariant');
          vendorOrder = result;
          vendorOrder.addUnique('vendorOrderVariants', vendorOrderVariant);
          
        } else {
          logInfo('VendorOrder is new');
          isNewOrder = true;
          vendorOrder = new VendorOrder();
          vendorOrder.set('vendor', vendor);
          vendorOrder.set('vendorOrderVariants', [vendorOrderVariant]);
          vendorOrder.set('orderedAll', false);
          vendorOrder.set('receivedAll', false);
          
        }
        return vendorOrder.save(null, {useMasterKey:true});
        
      }).then(function(result) {
        if (isNewOrder) vendorOrders.push(result);
        logInfo('VendorOrder saved');
        
        vendor.addUnique('vendorOrders', result);
        return vendor.save(null, {useMasterKey:true});
        
      }).then(function(result) {
        logInfo('Vendor saved');
        
/*
        if (vendorOrder) vendorOrderVariant.set('vendorOrder', vendorOrder);
        return vendorOrderVariant.save(null, {useMasterKey:true});
        
      }).then(function(result) {
*/
        
        if (orderProduct) {
          orderProduct.addUnique('vendorOrders', vendorOrder);
          return orderProduct.save(null, {useMasterKey:true});
        }
        return false;
        
      }).then(function(result) {
        if (result) logInfo('OrderProduct saved');
        return true;
        
      }, function(error) {
    		logError(error);
    		response.error(error.message);
    		
    	});
  	});
  	return promise;
  	
	}).then(function() {
  	
  	logInfo(productIds.length + ' product ids to save');
  	
  	var allPromises = [];
    var promise = Parse.Promise.as();
    
    _.each(productIds, function(productId) {
      logInfo('get product id: ' + productId);
      
      promise = promise.then(function() {
        var productQuery = new Parse.Query(Product);
        productQuery.equalTo('productId', productId);
        return productQuery.first();
      
      }).then(function(product) {
        return product.save(null, {useMasterKey: true});
        
      }).then(function(product) {
        var productQuery = new Parse.Query(Product);
        productQuery.equalTo('productId', productId);
        productQuery.include('variants');
        productQuery.include('variants.colorCode');
        productQuery.include('variants.stoneCode');
        productQuery.include('resizes');
        productQuery.include('resizes.resizeSourceVariant');
        productQuery.include('resizes.orderProduct');
        productQuery.include('department');
        productQuery.include('classification');
        productQuery.include('vendor');
        productQuery.include('vendor.vendorOrders');
        productQuery.include('vendor.vendorOrders.vendorOrderVariants');
        productQuery.include('vendor.vendorOrders.vendorOrderVariants.orderProducts');
        productQuery.include('bundleVariants');
        return productQuery.first();
      
      }).then(function(product) {
        updatedProducts.push(product);
        return true;
        
      }, function(error) {
    		logError(error);
    		response.error(error.message);
    		
    	});
    	allPromises.push(promise);
  	});
  	return Parse.Promise.when(allPromises);
  	
  }).then(function(result) {
    logInfo('get product tab counts');
    
    return Parse.Cloud.run('updateProductTabCounts');
    
  }).then(function(result) {
    logInfo('success');
    tabCounts = result;
    logInfo('addToVendorOrder completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    completed = true;
	  response.success({updatedProducts: updatedProducts, updatedVariants: updatedVariants, tabCounts: tabCounts});
    
	});
  
});

Parse.Cloud.define("createResize", function(request, response) {
  logInfo('createResize cloud function --------------------------', true);
  var startTime = moment();
  
  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 20000); 
  
  var resizes = request.params.resizes;
  var orderId = parseFloat(request.params.orderId);
  var updatedProductIds = [];
  var updatedProducts = [];
  var updatedVariants = [];
  var updatedOrders = [];
  var productIds = [];
  var errors = [];
  var tabCounts;
  
  var query = new Parse.Query(Product);
  query.count().then(function() {
    
    logInfo(resizes.length + ' resizes to add');
    
    var promise = Parse.Promise.as();
    
    _.each(resizes, function(resizeData) {
      var resize = (resizeData.resize == true || resizeData.resize == 'true') ? true : false;
      var orderProductId = resizeData.orderProductId ? parseFloat(resizeData.orderProductId) : null;
      var variantId = resizeData.variant;
      var resizeVariantId = resizeData.resizeVariant;
      var vendorId = resizeData.vendor;
      var units = parseFloat(resizeData.units);
      var notes = resizeData.notes;
      var variant;
      var resizeSourceVariant;
      var resizeObj;
      var resizeVariant;
      var product;
      var isNewResize = false;
      var numUnitsToRemove = 0;
      var orderProduct;
      
      promise = promise.then(function() {
        
        if (orderProductId) {
          var orderProductQuery = new Parse.Query(OrderProduct);
          orderProductQuery.equalTo('orderProductId', orderProductId);
          return orderProductQuery.first();
        } else {
          return false;
        }
        
      }).then(function(result) {
        if (result) orderProduct = result;
        
        logInfo('get variant: ' + variantId);
        
        // Get the requested ProductVariant
        var variantQuery = new Parse.Query(ProductVariant);
        variantQuery.equalTo('objectId', variantId);
        return variantQuery.first();
        
      }).then(function(result) {
        if (result) {
          logInfo('ProductVariant found');
          variant = result;
          updatedVariants.push(variant);
          if (productIds.indexOf(variant.get('productId') < 0)) productIds.push(variant.get('productId'));
          
          // Get the resize ProductVariant
          var variantQuery = new Parse.Query(ProductVariant);
          variantQuery.equalTo('objectId', resizeVariantId);
          return variantQuery.first();
          
        } else {
          logError('Product variant not found');
          errors.push('Product variant not found');
          return false;
        }
        
      }).then(function(result) {
        if (result) {
          logInfo('Resize ProductVariant found');
          resizeSourceVariant = result;
          updatedVariants.push(resizeSourceVariant);
        
          // Get the parent product
          var productQuery = new Parse.Query(Product);
          productQuery.equalTo('productId', variant.get('productId'));
          return productQuery.first();
          
        } else {
          logError('Resize source product variant not found');
          errors.push('Resize source product variant not found');
          return false;
        }
        
      }).then(function(result) {
        if (result) {
          logInfo('Product found');
          product = result;
          
          // Find a pending Resize
          var resizeQuery = new Parse.Query(Resize);
          resizeQuery.equalTo('variant', variant);
          resizeQuery.equalTo('resizeSourceVariant', resizeSourceVariant);
          resizeQuery.equalTo('done', false);
          if (orderProduct) resizeQuery.equalTo('orderProduct', orderProduct);
          return resizeQuery.first();
        
        } else {
          logError('Product not found');
          errors.push('Product not found');
          return false;
        }
        
      }).then(function(result) {
        if (result && product) {
          logInfo('Resize found, adjust number of units');
          resizeObj = result;
          resizeObj.increment('units', units); //TODO: PREVENT INCREMENT MORE THAN RESIZE INVENTORY
          if (resizeObj.has('notes') && resizeObj.get('notes') != '') {
            var updatedNotes = resizeObj.get('notes') + '<br/>' + notes;
            resizeObj.set('notes', updatedNotes);
          } else {
            resizeObj.set('notes', notes);
          }
            
        } else if (product) {
          logInfo('Resize is new');
          resizeObj = new Resize();
          resizeObj.set('variant', variant);
          resizeObj.set('resizeSourceVariant', resizeSourceVariant);
          resizeObj.set('units', units); //TODO: PREVENT UNITS MORE THAN RESIZE INVENTORY
          resizeObj.set('notes', notes);
          resizeObj.set('received', 0);
          resizeObj.set('done', false);
          
        } else {
          return false;
        }
        
        resizeObj.set('dateSent', moment().toDate());
        if (orderProduct) resizeObj.set('orderProduct', orderProduct);
        
        if (resizeSourceVariant.has('inventoryLevel') && resizeSourceVariant.get('inventoryLevel') < resizeObj.get('units')) {
          logInfo('resizeSourceVariant:' + resizeSourceVariant.get('inventoryLevel') + ', resizeObj:' + resizeObj.get('units'));
          logInfo('Requested units total is more than are available.', true);
          errors.push('Requested units total is more than are available.');
          return false;
        } else {
          return resizeObj.save(null, {useMasterKey:true});
        }
        
      }).then(function(result) {
        if (result) {
          logInfo('Resize saved');
          
          resizeSourceVariant.increment('inventoryLevel', units * -1);
          logInfo('Set inventory for variant ' + resizeSourceVariant.get('variantId') + ' to ' + resizeSourceVariant.get('inventoryLevel'), true);
          return resizeSourceVariant.save(null, {useMasterKey:true});
          
        } else {
          return false;
        }
        
      }).then(function(result) {
        if (result) {
          logInfo('Source ProductVariant saved');
          product.addUnique('resizes', resizeObj);
          product.set('hasResizeRequest', true);
          return product.save(null, {useMasterKey:true});
        } else {
          return false;
        }
        
      }).then(function(result) {
        if (result) logInfo('Product saved');
        
        if (orderProduct) {
          orderProduct.addUnique('resizes', resizeObj);
          return orderProduct.save(null, {useMasterKey:true});
        }
        return false;
        
      }).then(function(result) {
        if (result) logInfo('OrderProduct saved');
        return true;
        
        return true;
        
      }, function(error) {
    		logError(error);
    		
    	});
    	
  	});
  	return promise;
  	
	}).then(function() {
  	
  	logInfo(productIds.length + ' product ids to get');
  	
  	var allPromises = [];
    var promise = Parse.Promise.as();
    
    _.each(productIds, function(productId) {
      logInfo('get product id: ' + productId);
      
      promise = promise.then(function() {
        var productQuery = new Parse.Query(Product);
        productQuery.equalTo('productId', productId);
        productQuery.include('variants');
        productQuery.include('variants.colorCode');
        productQuery.include('variants.stoneCode');
        productQuery.include('resizes');
        productQuery.include('resizes.resizeSourceVariant');
        productQuery.include('resizes.orderProduct');
        productQuery.include('department');
        productQuery.include('classification');
        productQuery.include('vendor');
        productQuery.include('vendor.vendorOrders');
        productQuery.include('vendor.vendorOrders.vendorOrderVariants');
        productQuery.include('vendor.vendorOrders.vendorOrderVariants.orderProducts');
        productQuery.include('bundleVariants');
        return productQuery.first();
      
      }).then(function(product) {
        updatedProducts.push(product);
        return true;
        
      }, function(error) {
    		logError(error);
    		response.error(error.message);
    		
    	});
    	allPromises.push(promise);
  	});
  	
  	return Parse.Promise.when(allPromises);
  	
  }).then(function() {
    logInfo('products loaded');
    return Parse.Object.fetchAll(updatedVariants);
    
  }).then(function(results) {
    logInfo('variants loaded');
    updatedVariants = results;
    if (orderId) {
      logInfo('get order tab counts');
      return Parse.Cloud.run('updateOrderTabCounts');      
    } else {
      logInfo('get product tab counts');
      return Parse.Cloud.run('updateProductTabCounts');
    }
    
  }).then(function(result) {
    tabCounts = result;
    
    if (orderId) {
      var orderQuery = new Parse.Query(Order);
      orderQuery.equalTo('orderId', orderId);
      orderQuery.include('orderProducts');
      orderQuery.include('orderProducts.variants');
      orderQuery.include('orderProducts.variants.designer');
      orderQuery.include('orderProducts.vendorOrders');
      orderQuery.include('orderProducts.vendorOrders.vendorOrderVariants');
      orderQuery.include('orderProducts.vendorOrders.vendorOrderVariants.vendor');
      orderQuery.include('orderShipments');
      orderQuery.include('orderProducts.resizes');
      orderQuery.include('orderProducts.awaitingInventory');
      orderQuery.include('orderProducts.awaitingInventory.vendorOrder');
      return orderQuery.find();
    } else {
      return;
    }
    
  }).then(function(results) {
    if (results) updatedOrders = results;
    
    logInfo('createResize completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    completed = true;
	  response.success({updatedProducts: updatedProducts, updatedVariants: updatedVariants, updatedOrders: updatedOrders, tabCounts: tabCounts, errors: errors});
    
	}, function(error) {
		logError(error);
		response.error(error.message);
	});
  
});

Parse.Cloud.define("saveResize", function(request, response) {
  logInfo('saveResize cloud function --------------------------', true);
  var startTime = moment();
  
  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 20000); 
  
  var resizeId = request.params.data.resizeId;
  var units = parseFloat(request.params.data.units);
  var received = parseFloat(request.params.data.received);
  var orderId = parseFloat(request.params.data.resizeId);
  var resizeObj;
  var variant;
  var resizeSourceVariant;
  var product;
  var updatedProducts = [];
  var updatedVariants = [];
  var productIds = [];
  var errors = [];
  var tabCounts;
  
  // Find a pending Resize
  var resizeQuery = new Parse.Query(Resize);
  resizeQuery.equalTo('objectId', resizeId);
  resizeQuery.include('variant');
  resizeQuery.include('resizeSourceVariant');
  resizeQuery.first().then(function(result) {
    resizeObj = result;
    
    if (result) {
      logInfo('Resize found');
      resizeObj = result;
      
      variant = resizeObj.get('variant');
      resizeSourceVariant = resizeObj.get('resizeSourceVariant');
      updatedVariants.push(variant);
      updatedVariants.push(resizeSourceVariant);
      if (productIds.indexOf(variant.get('productId') < 0)) productIds.push(variant.get('productId'));
      
      var unitsDiff = resizeObj.get('units') - units;
      console.log('unitsDiff: ' + unitsDiff + ' source inventory:' + resizeSourceVariant.get('inventoryLevel') + ' units:' + units);
      
      if (unitsDiff != 0 && resizeSourceVariant.get('inventoryLevel') < units) {
        logInfo('Requested units total is more than are available.', true);
        errors.push('Requested units total is more than are available.');
        return false;
        
      } else {
        if (unitsDiff != 0) {
          resizeSourceVariant.increment('inventoryLevel', unitsDiff);
          logInfo('Set inventory for variant ' + resizeSourceVariant.get('variantId') + ' to ' + resizeSourceVariant.get('inventoryLevel'), true);
          resizeObj.set('units', units);
        }
        
        if (received) {
          var receivedDiff = resizeObj.has('received') ? received - resizeObj.get('received') : received;
          if (receivedDiff != 0 && !resizeObj.has('orderProduct')) {
            variant.increment('inventoryLevel', receivedDiff);
            logInfo('Set inventory for variant ' + variant.get('variantId') + ' to ' + variant.get('inventoryLevel'), true);
          }
          resizeObj.set('received', received);
        } else {
          resizeObj.set('received', 0);
        }
        
        logInfo('received ' + resizeObj.get('received') + ' of ' + resizeObj.get('units') + ' units');
        if (resizeObj.get('received') >= resizeObj.get('units')) resizeObj.set('done', true);
        
        return resizeObj.save(null, {useMasterKey:true});
      }
        
    } else {
      logError('Resize not found');
      errors.push('Resize not found');
      return false;
    }
    
  }).then(function(result) {
    if (result) {
      logInfo('Resize saved');
      return resizeSourceVariant.save(null, {useMasterKey:true});
      
    } else {
      return false;
    }
        
  }).then(function(result) {
    if (result) {
      logInfo('resizeSourceVariant saved');
      return variant.save(null, {useMasterKey:true});
      
    } else {
      return false;
    }
        
  }).then(function(result) {
    if (result) {
      logInfo('variant saved');
      var productQuery = new Parse.Query(Product);
      productQuery.equalTo('productId', variant.get('productId'));
      productQuery.include('resizes');
      return productQuery.first();
    } else {
      return false;
    }
      
  }).then(function(result) {
    product = result;
    if (result) {
      if (resizeObj.get('done') == false && units > 0) {
        product.addUnique('resizes', resizeObj);
      } else {
        product.remove('resizes', resizeObj);
      }
      return product.save(null, {useMasterKey:true});
    } else {
      return false;
    }
        
  }).then(function(result) {
    if (result) logInfo('Product saved');
  	
  	logInfo(productIds.length + ' product ids to get');
  	
    var promise = Parse.Promise.as();
    
    _.each(productIds, function(productId) {
      logInfo('get product id: ' + productId);
      
      promise = promise.then(function() {
        var productQuery = new Parse.Query(Product);
        productQuery.equalTo('productId', productId);
        productQuery.include('variants');
        productQuery.include('variants.colorCode');
        productQuery.include('variants.stoneCode');
        productQuery.include('resizes');
        productQuery.include('resizes.resizeSourceVariant');
        productQuery.include('resizes.orderProduct');
        productQuery.include('department');
        productQuery.include('classification');
        productQuery.include('vendor');
        productQuery.include('vendor.vendorOrders');
        productQuery.include('vendor.vendorOrders.vendorOrderVariants');
        productQuery.include('vendor.vendorOrders.vendorOrderVariants.orderProducts');
        productQuery.include('bundleVariants');
        return productQuery.first();
      
      }).then(function(product) {
        updatedProducts.push(product);
        return true;
        
      }, function(error) {
    		logError(error);
    		response.error(error.message);
    		
    	});
  	});
  	
  	return promise;
  	
  }).then(function(result) {
    logInfo('products loaded');
    return Parse.Object.fetchAll(updatedVariants);
    
  }).then(function(results) {
    logInfo('variants loaded');
    updatedVariants = results;
    logInfo('get product tab counts');
    return Parse.Cloud.run('updateProductTabCounts');
    
  }).then(function(result) {
    tabCounts = result;
    
    if (orderId) {
      var orderQuery = new Parse.Query(Order);
      orderQuery.equalTo('orderId', orderId);
      orderQuery.include('orderProducts');
      orderQuery.include('orderProducts.variants');
      orderQuery.include('orderProducts.variants.designer');
      orderQuery.include('orderProducts.vendorOrders');
      orderQuery.include('orderProducts.vendorOrders.vendorOrderVariants');
      orderQuery.include('orderProducts.vendorOrders.vendorOrderVariants.vendor');
      orderQuery.include('orderShipments');
      orderQuery.include('orderProducts.resizes');
      orderQuery.include('orderProducts.awaitingInventory');
      orderQuery.include('orderProducts.awaitingInventory.vendorOrder');
      return orderQuery.find();
    } else {
      return [];
    }
    
  }).then(function(results) {
    updatedOrders = results;
    
    logInfo('saveResize completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    completed = true;
	  response.success({updatedProducts: updatedProducts, updatedVariants: updatedVariants, updatedOrders: updatedOrders, tabCounts: tabCounts, errors: errors});
    
	}, function(error) {
		logError(error);
		response.error(error.message);
	});
  
});

Parse.Cloud.define("updateAwaitingInventoryQueue", function(request, response) {
  logInfo('updateAwaitingInventoryQueue cloud function --------------------------', true);
  var startTime = moment();
  
  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 20000); 
  
  var awaitingInventory = [];
  var orderProductsIneligible = [];
  var orderProductsToQueue = [];
  var errors = [];
  
  var vendorOrdersQuery = new Parse.Query(VendorOrder);
  vendorOrdersQuery.equalTo('orderedAll', true);
  vendorOrdersQuery.equalTo('receivedAll', false);
  vendorOrdersQuery.include('vendorOrderVariants');
  vendorOrdersQuery.include('vendorOrderVariants.variant');
  vendorOrdersQuery.include('vendorOrderVariants.orderProducts');
  vendorOrdersQuery.include('resizeSourceVariant');
  vendorOrdersQuery.ascending('dateOrdered');
  vendorOrdersQuery.limit(10000);
  vendorOrdersQuery.find().then(function(results) {
    var vendorOrders = results;
    logInfo(vendorOrders.length ? vendorOrders.length + ' vendor orders to parse' : 'No vendor orders to parse');
    if (vendorOrders.length) {
      _.each(vendorOrders, function(vendorOrder) {
        _.each(vendorOrder.get('vendorOrderVariants'), function(vendorOrderVariant) {
          if (vendorOrderVariant.get('done') == false && !vendorOrderVariant.has('orderProducts')) {
//             logInfo('vendorOrderVariant ' + vendorOrderVariant.id + ' is available for queue');
            var numAvailable = vendorOrderVariant.get('units') - vendorOrderVariant.get('received');
            awaitingInventory.push({object: vendorOrderVariant, available: numAvailable, vendorOrder: vendorOrder});
          }
        });
      });
    }
    
    var resizesQuery = new Parse.Query(Resize);
    resizesQuery.equalTo('done', false);
    resizesQuery.include('variant');
    resizesQuery.include('orderProduct');
    resizesQuery.ascending('dateSent');
    resizesQuery.limit(10000);
    return resizesQuery.find();
    
  }).then(function(results) {
    var resizeObjects = results;
    logInfo(resizeObjects.length ? resizeObjects.length + ' resizes to parse' : 'No resizes to parse');
    if (resizeObjects.length) {
      _.each(resizeObjects, function(resizeObject) {
          if (resizeObject.get('done') == false && !resizeObject.has('orderProduct')) {
//             logInfo('resize ' + resizeObject.id + ' is available for queue');
            var numAvailable = resizeObject.get('units') - resizeObject.get('received');
            awaitingInventory.push({object: resizeObject, available: numAvailable});
          }
      });
    }
    
    var ordersQuery = new Parse.Query(Order);
    ordersQuery.equalTo('fullyShippable', false);
    ordersQuery.equalTo('is_deleted', false);
    ordersQuery.containedIn('status_id', PENDING_ORDER_STATUSES);
    ordersQuery.ascending('date_created');
    ordersQuery.include('orderProducts');
    ordersQuery.include('orderProducts.variants');
    ordersQuery.limit(10000);
    return ordersQuery.find();
    
  }).then(function(results) {
    var orders = results;
    logInfo(orders.length ? orders.length + ' orders to parse' : 'No orders to parse');
    if (orders.length) {
      _.each(orders, function(order) {
        _.each(order.get('orderProducts'), function(orderProduct) {
          if (orderProduct.get('quantity_shipped') < orderProduct.get('quantity') && !orderProduct.has('vendorOrders') && !orderProduct.has('resizes') && orderProduct.get('shippable') == false) {
//             logInfo('orderProduct ' + orderProduct.get('orderProductId') + ' from order ' + orderProduct.get('order_id') + ' is available for queue');
            orderProductsToQueue.push(orderProduct);
          } else {
//             logInfo('orderProduct ' + orderProduct.get('orderProductId') + ' from order ' + orderProduct.get('order_id') + ' not being queued');
            orderProduct.unset('awaitingInventory');
            orderProduct.unset('awaitingInventoryVendorOrders');
            orderProductsIneligible.push(orderProduct);
          }
        });
      });
    }
    logInfo('Total to process queue: ' + awaitingInventory.length + ' items, ' + orderProductsToQueue.length + ' orderProducts');
    
    if (orderProductsToQueue.length > 0) {
      var totalOrderProductsQueued = 0;
      _.each(orderProductsToQueue, function(orderProduct) {
        var orderProductAwaitingInventory = [];
        var orderProductAwaitingInventoryVendorOrders = [];
        var variants = orderProduct.has('variants') ? orderProduct.get('variants') : [];
        _.each(variants, function(variant) {
          var awaitingInventoryEdited = [];
          var index;
          for (var i = 0; i < awaitingInventory.length; i++) {
            var item = awaitingInventory[i];
            if (item.object.get('variant').id == variant.id) {
              var numNeeded = orderProduct.get('quantity') - orderProduct.get('quantity_shipped');
              logInfo('Matched variant ' + variant.get('variantId') + '. In stock ' + variant.get('inventoryLevel') + ', need ' + numNeeded + ', available ' + item.available);
              if (item.available >= numNeeded) {
                var numToSubtract = numNeeded < item.available ? numNeeded : item.available;
                logInfo('Subtract ' + numToSubtract + ' for ' + variant.get('variantId'));
                item.available -= numToSubtract;
              } else {
                logInfo('No more available for ' + variant.get('variantId'));
              }
              orderProductAwaitingInventory.push(item.object);
              if (item.vendorOrder) orderProductAwaitingInventoryVendorOrders.push(item.vendorOrder);
              index = i;
//               break;
            } 
            awaitingInventoryEdited.push(item); // subtract added then add to array if has any awaiting left
          }
          awaitingInventory = awaitingInventoryEdited;

        });
        if (orderProductAwaitingInventory.length > 0) {
          totalOrderProductsQueued++;
          orderProduct.set('awaitingInventory', orderProductAwaitingInventory);
          if (orderProductAwaitingInventoryVendorOrders.length > 0) {
            orderProduct.set('awaitingInventoryVendorOrders', orderProductAwaitingInventoryVendorOrders);
          } else {
            orderProduct.unset('awaitingInventoryVendorOrders');
          }
        } else {
          orderProduct.unset('awaitingInventory');
          if (orderProduct.has('awaitingInventoryVendorOrders')) orderProduct.unset('awaitingInventoryVendorOrders');
        }
      });
      logInfo('Total order products in vendor order queue: ' + totalOrderProductsQueued);
      var allOrderProducts = orderProductsToQueue.concat(orderProductsIneligible);
      return Parse.Object.saveAll(allOrderProducts, {useMasterKey: true});
    } else {
      return Parse.Object.saveAll(orderProductsIneligible, {useMasterKey: true});
      return false;
    }
    
  }).then(function(results) {
    logInfo('updateAwaitingInventoryQueue completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    completed = true;
    response.success({errors: errors});
    
  }, function(error) {
		logError(error);
		response.error(error);
		
	});
  
});

Parse.Cloud.define("loadCategory", function(request, response) {
  logInfo('loadCategory cloud function --------------------------', true);
  var startTime = moment();
  
  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 20000);
  
  var category = request.params.category;
  var added = false;
  
  var categoryQuery = new Parse.Query(Category);
  categoryQuery.equalTo('categoryId', parseFloat(category.id));
  categoryQuery.first().then(function(categoryResult) {
    if (categoryResult) {
      logInfo('Category ' + categoryResult.get('categoryId') + ' exists.');
      return createCategoryObject(category, categoryResult).save(null, {useMasterKey: true});
    } else {
      logInfo('Category ' + category.id + ' is new.');
      added = true;
      return createCategoryObject(category).save(null, {useMasterKey: true});
    }
    
  }).then(function(categoryObject) {
    logInfo('loadCategory completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    completed = true;
    response.success({added: added});
    
  }, function(error) {
		logError(error);
		response.error(error.message);
		
	});
});

Parse.Cloud.define("getBundleFormData", function(request, response) {
  logInfo('getBundleFormData cloud function --------------------------', true);
  var startTime = moment();
  
  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 20000);
  
  var productId = request.params.productId;
  
  var productsQuery = new Parse.Query(Product);
  productsQuery.include('variants');
  productsQuery.limit(10000);
  productsQuery.ascending('productId');
  productsQuery.notEqualTo('isBundle', true);
  productsQuery.find().then(function(results) {
//     var products = queryResultsToJSON(results);
    var products = [];
    _.each(results, function(result) {
      var product = result.toJSON();
      if (result.has('variants')) {
        var variants = result.get('variants');
        var variantsJSON = [];
        _.each(variants, function(variant) {
          variantsJSON.push(variant.toJSON());
        });
        product.variants = variantsJSON;
      }
      products.push(product);
    });
    logInfo('getBundleFormData completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    completed = true;
    response.success(products);
    
  }, function(error) {
		logError(error);
		response.error(error.message);
		
	});
});

Parse.Cloud.define("productBundleSave", function(request, response) {
  logInfo('productBundleSave cloud function --------------------------', true);
  var startTime = moment();
  
  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 20000);
  
  var bundleProductId = request.params.data.bundleProductId;
  var bundleVariantIds = request.params.data.bundleVariants;
  var bundleProduct;
  var bundleVariants = [];
  var updatedProducts = [];
  
  var productQuery = new Parse.Query(Product);
  productQuery.equalTo('productId', bundleProductId);
  productQuery.first().then(function(result) {
    bundleProduct = result;
    
    logInfo(bundleVariantIds.length + ' bundle variants to save');
    
    var promise = Parse.Promise.as();
    
    _.each(bundleVariantIds, function(bundleVariantId) {
      promise = promise.then(function() {
        logInfo('getting variant: ' + bundleVariantId);
        
        var variantQuery = new Parse.Query(ProductVariant);
        variantQuery.equalTo('objectId', bundleVariantId);
        return variantQuery.first();
        
      }).then(function(variant) {
        if (variant) {
          logInfo('variant found');
          bundleVariants.push(variant);
        } else {
          logInfo('no variant found');
        }
        
      });
    	
  	});
  	return promise;
  	
	}).then(function() {
  	bundleProduct.set('bundleVariants', bundleVariants);
  	var isBundle = bundleVariants.length > 0 ? true : false;
  	if (isBundle) bundleProduct.set('isBundle', isBundle);
  	return bundleProduct.save(null, {useMasterKey: true});
  	
	}).then(function(result) {
  	
  	return Parse.Cloud.run('loadProductVariants', {productId: bundleProductId});
    
  }).then(function(result) {
  	
//     var productQuery = new Parse.Query(Product);
//     productQuery.equalTo('objectId', bundleProductId);
    productQuery.include('variants');
    productQuery.include('variants.colorCode');
    productQuery.include('variants.stoneCode');
    productQuery.include('resizes');
    productQuery.include('resizes.resizeSourceVariant');
    productQuery.include('resizes.orderProduct');
    productQuery.include('department');
    productQuery.include('classification');
    productQuery.include('vendor');
    productQuery.include('vendor.vendorOrders');
    productQuery.include('vendor.vendorOrders.vendorOrderVariants');
    productQuery.include('vendor.vendorOrders.vendorOrderVariants.orderProducts');
    productQuery.include('bundleVariants');
    return productQuery.first();
        
    
  }).then(function(result) {
    updatedProducts.push(result);
    logInfo('productBundleSave completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    completed = true;
	  response.success({updatedProducts: updatedProducts});
    
	}, function(error) {
		logError(error);
		response.error(error.message);
		
	});
  
});


/////////////////////////
//  BEFORE SAVE        //
/////////////////////////

Parse.Cloud.beforeSave("Product", function(request, response) {
  logInfo('Product beforeSave --------------------------');
  var product = request.object;
  var variants;
  var designer;
  var vendor;
  var vendorOrders;
  var resizes;

  var toLowerCase = function(w) { return w.toLowerCase(); };

  var searchTerms = product.get("name").split(' ');
  searchTerms = _.map(searchTerms, toLowerCase);
  var stopWords = ["the", "in", "and", "with"];
  searchTerms = _.filter(searchTerms, function(w) { return !_.contains(stopWords, w); });
  logInfo(searchTerms);
  product.set("search_terms", searchTerms);
  
  var resizes = product.get('resizes');
  if (resizes && resizes.length > 0) {
    logInfo('product has resizes');
    product.set('hasResizeRequest', true);
  } else {
    logInfo('product does not have resizes');
    product.set('hasResizeRequest', false);
  }
  
  if (!product.has('variants')) {
    logInfo('product has no variants');
    product.set('total_stock', 0);
    response.success();
    
  } else {
    logInfo('get stock for product variants');
    variants = product.get('variants');
    var totalStock = 0;
    var variantsOutOfStock = 0;
    var sizes = [];
    Parse.Object.fetchAll(variants).then(function(variantObjects) {
      variants = variantObjects;
      _.each(variants, function(variant) {
        var inventory = variant.get('inventoryLevel');
        if (inventory) {
          if (inventory > 0) totalStock += inventory;
          if (inventory <= 0) variantsOutOfStock++;
        } else {
          variantsOutOfStock++;
        }
  			if (!variant.variantOptions) {
    			logInfo('variant has no options: ' + variant.productName + ' ' + variant.variantId); 
  			} else {
    			_.each(variant.variantOptions, function(variantOption) {
      			if (variantOption.option_id === 32) sizes.push(parseFloat(variantOption.value));
    			});
  			}
      });
      logInfo('total stock: ' + totalStock);
      product.set('total_stock', totalStock);
      product.set('variantsOutOfStock', variantsOutOfStock);
      
      sizes.sort((a, b) => (a - b));
      var sizeScale = (sizes.length > 0) ? sizes[0] + '-' + sizes[sizes.length-1] : 'OS' ;
      logInfo('set size scale: ' + sizeScale);
      product.set('sizeScale', sizeScale);
      
      if (product && !product.has('designer')) {
        logInfo('product does not have designer');
        return;
      }
      
      logInfo('fetch designer');
      var designerObj = product.get('designer');
      return designerObj.fetch();
      
    }, function(error) {
    	logError(error);
  		response.error(error.message);
    }).then(function(result) {
      designer = result;
      
      var vendorsArray = [];
      if (product && product.has('vendor')) {
        logInfo('product has vendor');
        var vendorObj = product.get('vendor');
        vendorsArray.push(vendorObj);
      } else if (designer && designer.has('vendors')) {
        logInfo('get vendors from product designer');
        vendorsArray = designer.get('vendors');
      } else {
        logInfo('product does not have vendors');
        vendorsArray = [];
      }
      
      return Parse.Object.fetchAll(vendorsArray);
      
    }, function(error) {
    	logError(error);
  		response.error(error.message);
  		
    }).then(function(vendors) {
      
      if (vendors.length > 1) {
        logInfo('multiple vendors found for product, needs to be manually selected');
        return;
        
      } else if (vendors.length == 1) {
        logInfo('single vendor found for product, automatically select');
        product.set('vendor', vendors[0]);
        var vendorObj = product.get('vendor');
        var vendorOrderQuery = new Parse.Query(VendorOrder);
        vendorOrderQuery.equalTo('vendor', vendorObj);
        vendorOrderQuery.equalTo('orderedAll', true);
        vendorOrderQuery.equalTo('receivedAll', false);
        vendorOrderQuery.include('vendorOrderVariants');
        vendorOrderQuery.include('vendorOrderVariants.variant');
        return vendorOrderQuery.find();
        
      } else {
        logInfo('no vendors found for product');
        return;
        
      }
      
    }, function(error) {
    	logError(error);
  		response.error(error.message);
  		
    }).then(function(result) {
      vendorOrders = result;
      
      var resizesQuery = new Parse.Query(Resize);
      resizesQuery.equalTo('done', false);
      resizesQuery.include('variant');
      return resizesQuery.find();
      
    }).then(function(result) {
      resizes = result;
      
      if (vendorOrders && vendorOrders.length) {
        logInfo('product has ' + vendorOrders.length + ' vendor orders');
        var hasVendorOrder = false;
        _.each(vendorOrders, function(vendorOrder) {
          var matchesProduct = false;
          _.each(vendorOrder.get('vendorOrderVariants'), function(vendorOrderVariant) {
            var variant = vendorOrderVariant.get('variant');
            if (variant.get('productId') == product.get('productId') && vendorOrderVariant.get('done') == false) matchesProduct = true;
          });
          if (matchesProduct) hasVendorOrder = true;
        });
        product.set('hasVendorOrder', hasVendorOrder);

      } else {
        logInfo('product does not have pending vendor order');
        product.set('hasVendorOrder', false);
      }
      
      // Get counts of all awaiting inventory for each variant
      var editedVariants = [];
      var productTotalAwaiting = 0;
      _.each(variants, function(variant) {
        var variantVendorOrderVariants = [];
        var variantResizes = [];
        var variantTotalAwaiting = 0;
        if (vendorOrders) {
          _.each(vendorOrders, function(vendorOrder) {
            _.each(vendorOrder.get('vendorOrderVariants'), function(vendorOrderVariant) {
              if (variant.id == vendorOrderVariant.get('variant').id && vendorOrderVariant.get('ordered') == true) {
//                 variantVendorOrderVariants.push(vendorOrderVariant);
                var awaiting = vendorOrderVariant.get('units') - vendorOrderVariant.get('received');
                if (awaiting < 0) awaiting = 0;
                variantTotalAwaiting += awaiting;
                productTotalAwaiting += awaiting;
              }
            });
          });
        }
        if (resizes) {
          _.each(resizes, function(resize) {
            if (variant.id == resize.get('variant').id) {
              variantResizes.push(resize);
              var awaiting = resize.get('units') - resize.get('received');
              if (awaiting < 0) awaiting = 0;
              variantTotalAwaiting += awaiting;
              productTotalAwaiting += awaiting;
            }
          });
        }
        logInfo('Variant has ' + variantTotalAwaiting + ' total awaiting inventory');
//         variant.set('vendorOrderVariants', variantVendorOrderVariants);
        variant.set('resizes', variantResizes);
        variant.set('totalAwaitingInventory', variantTotalAwaiting);
        editedVariants.push(variant);
      });
      logInfo('Product has ' + productTotalAwaiting + ' total awaiting inventory');
      product.set('totalAwaitingInventory', productTotalAwaiting);
      
      return Parse.Object.saveAll(editedVariants, {useMasterKey: true});
      
    }).then(function(result) {
      logInfo('Variants saved');
      
      response.success();
    }, function(error) {
    	logError(error);
  		response.error(error.message);
    });
    
  }
});

Parse.Cloud.beforeSave("ProductVariant", function(request, response) {
  logInfo('ProductVariant beforeSave --------------------------');
  var productVariant = request.object;
  var variantOptions = productVariant.has('variantOptions') ? productVariant.get('variantOptions') : null;

  // Create the color code for variant
  if (variantOptions) {
    logInfo('Load color and stone codes');
    var totalOptions = variantOptions.length;
    var optionsChecked = 0;
    var colorCodes = [];
    var stoneCodes = [];
    logInfo('totalOptions: ' + totalOptions);
    _.each(variantOptions, function(variantOption) {
      var colorCodeQuery = new Parse.Query(ColorCode);
      colorCodeQuery.equalTo('option_id', parseInt(variantOption.option_id));
      colorCodeQuery.equalTo('option_value_id', parseInt(variantOption.option_value_id));
  		colorCodeQuery.first().then(function(colorCodeResult) {
        if (colorCodeResult) {
          logInfo('ColorCode matched: ' + colorCodeResult.get('label'));
          colorCodes.push(colorCodeResult);
        }
        var stoneCodeQuery = new Parse.Query(StoneCode);
        stoneCodeQuery.equalTo('option_id', parseInt(variantOption.option_id));
        stoneCodeQuery.equalTo('option_value_id', parseInt(variantOption.option_value_id));
        return stoneCodeQuery.first();

      }).then(function(stoneCodeResult) {
        if (stoneCodeResult) {
          logInfo('StoneCode matched: ' + stoneCodeResult.get('label'));
          stoneCodes.push(stoneCodeResult);
        }
        optionsChecked++;
        if (optionsChecked == totalOptions) {
          logInfo('total color codes: ' + colorCodes.length);
          logInfo('total stone codes: ' + stoneCodes.length);
          if (colorCodes.length > 1) {
            productVariant.set('colorCodes', colorCodes);
            productVariant.unset('colorCode');
          } else if (colorCodes.length == 1) {
            productVariant.set('colorCode', colorCodes[0]);
            productVariant.unset('colorCodes');
          } else {
            productVariant.unset('colorCode');
            productVariant.unset('colorCodes');
          }
          if (stoneCodes.length > 1) {
            productVariant.set('stoneCodes', stoneCodes);
            productVariant.unset('stoneCodes');
          } else if (stoneCodes.length == 1) {
            productVariant.set('stoneCode', stoneCodes[0]);
            productVariant.unset('stoneCodes');
          } else {
            productVariant.unset('stoneCode');
            productVariant.unset('stoneCodes');
          }
          var allCodeObjects = colorCodes.concat(stoneCodes);
          var allCodes = _.map(allCodeObjects, function(codeObj) { 
            return codeObj.has('manualCode') ? codeObj.get('manualCode') : codeObj.get('generatedCode'); 
          });
          var codeString = allCodes.join('');
          logInfo('code: ' + codeString);
          productVariant.set('code', codeString);
          
          response.success();
        }
      });
    });
  
  } else {
    logInfo('No variant options');
    response.success();
  }

});

/////////////////////////
//  AFTER SAVE         //
/////////////////////////

Parse.Cloud.afterSave("Product", function(request) {  
  var productId = request.object.get('productId');
  
  delay(5000).then(function() {
    logInfo('Product afterSave '  + productId + ' --------------------------', true);
  
    var ordersQuery = new Parse.Query(Order);
    ordersQuery.equalTo('productIds', productId);
    ordersQuery.containedIn('status_id', PENDING_ORDER_STATUSES);
    return ordersQuery.find();
    
  }).then(function(orders) {
    if (!orders) return true;
    
    logInfo('Product afterSave ' + orders.length + ' orders found for ' + productId, true);
    
    var items = [];
		_.each(orders, function(order) {
      items.push(order.get('orderId'));
    });
    
    return Parse.Cloud.run('addToReloadQueue', {objectClass: 'Order', items: items});
    
  }).then(function(result) {
    logInfo('Product afterSave success for product ' + productId);
    
  });
});


/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

var delay = function(t) {
  return new Promise(function(resolve) { 
    setTimeout(resolve, t)
  });
}

var optionIsPurchasingEnabled = function(option_id, option_value_id, rules) {
  var isEnabled = true;
  _.each(rules, function(rule) {
    if (rule.is_enabled && rule.is_purchasing_disabled) {
      _.each(rule.conditions, function(condition) {
        if (condition.option_value_id == option_value_id) {
          isEnabled = false;
        }
      });
    }
  });
  return isEnabled;
};

var optionPriceAdjustment = function(option_id, option_value_id, rules) {
  var adjustment;
  _.each(rules, function(rule) {
    if (rule.is_enabled && rule.price_adjuster) {
      _.each(rule.conditions, function(condition) {
        if (condition.option_value_id == option_value_id) {
          logInfo('adjust price ' + rule.price_adjuster.adjuster_value);
          adjustment = { "adjuster": rule.price_adjuster.adjuster, "adjuster_value": rule.price_adjuster.adjuster_value };
        }
      });
    }
  });
  return adjustment;
};

var allCombinations = function(array) {
  if(!array.length) {
    return [];
  }

  // wrap non-array values
  // e.g. ['x',['y','z']] becomes [['x'],['y','z']]
  array = array.map(function (item) {
    return item instanceof Array ? item : [item];
  });

  // internal recursive function
  function combine(list) {
    var prefixes, combinations;

    if(list.length === 1) {
      return list[0];
    }

    prefixes = list[0];
    combinations = combine(list.slice(1)); // recurse

    // produce a flat list of each of the current
    // set of values prepended to each combination
    // of the remaining sets.
    return prefixes.reduce(function (memo, prefix) {
      return memo.concat(combinations.map(function (combination) {
        return [prefix].concat(combination);
      }));
    }, []);
  }

  return combine(array);
}

var createProductObject = function(productData, classes, departments, designers, currentProduct) {
  var productObj = (currentProduct) ? currentProduct : new Product();
  
  productObj.set('productId', parseInt(productData.id));
  productObj.set('name', productData.name);
  productObj.set('sku', productData.sku);
  productObj.set('price', parseFloat(productData.price));
  productObj.set('cost_price', parseFloat(productData.cost_price));
  productObj.set('retail_price', parseFloat(productData.retail_price));
  productObj.set('sale_price', parseFloat(productData.sale_price));
  productObj.set('calculated_price', parseFloat(productData.calculated_price));
  productObj.set('is_visible', productData.is_visible == true);
  productObj.set('inventory_tracking', productData.inventory_tracking);
  productObj.set('total_sold', parseInt(productData.total_sold));
  productObj.set('date_created', moment.utc(productData.date_created, 'ddd, DD MMM YYYY HH:mm:ss Z').toDate());
  productObj.set('brand_id', parseInt(productData.brand_id));
  productObj.set('view_count', parseInt(productData.view_count));
  productObj.set('categories', productData.categories);
  productObj.set('date_modified', moment.utc(productData.date_modified, 'ddd, DD MMM YYYY HH:mm:ss Z').toDate());
  productObj.set('condition', productData.condition);
  productObj.set('is_preorder_only', productData.is_preorder_only == 'true');
  productObj.set('custom_url', productData.custom_url);
  productObj.set('option_set_id', parseInt(productData.option_set_id));
  productObj.set('primary_image', productData.primary_image);
  productObj.set('availability', productData.availability);
  
  if (!productObj.has('wholesalePrice')) productObj.set('wholesalePrice', parseFloat(productData.price) / 2.2);
  
  if (!productObj.has('is_active')) productObj.set('is_active', true);
  
  _.each(classes, function(classObj) {
    if (classObj.get('category_id') && (productData.categories.indexOf(classObj.get('category_id').toString()) >= 0 || productData.categories.indexOf(parseFloat(classObj.get('category_id'))) >= 0)) {
      logInfo('set classification to ' + classObj.get('category_id'));
      productObj.set('classification', classObj);
    }
  });
  
  _.each(departments, function(departmentObj) {
    if (departmentObj.get('category_id') && (productData.categories.indexOf(departmentObj.get('category_id').toString()) >= 0 || productData.categories.indexOf(parseFloat(departmentObj.get('category_id'))) >= 0)) {
      logInfo('set department to ' + departmentObj.get('category_id'));
      productObj.set('department', departmentObj);
    }
  });
  
  _.each(designers, function(designerObj) {
    if (productObj.get('brand_id') == designerObj.get('designerId')) {
      productObj.set('designer', designerObj);
    }
  });
  
  var designer = productObj.get('designer');
  var department = productObj.get('department');
  var classification = productObj.get('classification');
  
  // Create Style Number
	var styleNumber = '';
	var designerAbbreviation = designer ? designer.get('abbreviation') : '[DESIGNER]';
	styleNumber += designerAbbreviation;
	var dateCreated = productObj.get('date_created');
  var yearNum = parseFloat(moment(dateCreated.iso).format('YYYY')) - 2015;
  var yearLetter = yearLetters[yearNum];
  styleNumber += yearLetter;
  var season = parseFloat(moment(dateCreated.iso).format('M'));
  styleNumber += season;
  var departmentLetter = department ? department.get('letter') : '[DEPARTMENT]';
  styleNumber += departmentLetter;
  var classStartId = classification ? classification.get('start_id') : 0;
  logInfo('classStartId: ' + classStartId);
  var classificationNumber;
  
  var promise = Parse.Promise.as();
  promise = promise.then(function() {
    
    logInfo('search for style number: ' + styleNumber);
    var styleNumbersQuery = new Parse.Query(StyleNumber);
    styleNumbersQuery.limit(10000);
    styleNumbersQuery.equalTo('designerAbbreviation', designerAbbreviation);
    styleNumbersQuery.equalTo('yearLetter', yearLetter);
    styleNumbersQuery.equalTo('season', season);
    styleNumbersQuery.equalTo('department', departmentLetter);
    styleNumbersQuery.equalTo('classification', classStartId);
    return styleNumbersQuery.first();
  
  }).then(function(result) {
    var styleNumberObj;
    
    if (result) {
      logInfo('style number exists');
      styleNumberObj = result;
      if (!productObj.has('classificationNumber')) {
        styleNumberObj.increment('classificationCounter');
        classificationNumber = styleNumberObj.get('classificationCounter');
      } else {
        classificationNumber = productObj.get('classificationNumber');
      }
    } else {
      logInfo('style number is new');
      styleNumberObj = new StyleNumber();
      styleNumberObj.set('designerAbbreviation', designerAbbreviation);
      styleNumberObj.set('yearLetter', yearLetter);
      styleNumberObj.set('season', season);
      styleNumberObj.set('department', departmentLetter);
      styleNumberObj.set('classification', classStartId);
      styleNumberObj.set('classificationCounter', classStartId);
      classificationNumber = classStartId;
    }
    styleNumber += classificationNumber;
    logInfo('save: ' + styleNumber);
    return styleNumberObj.save(null, {useMasterKey: true});
    
  }).then(function(result) {
    productObj.set('classificationNumber', classificationNumber);
    productObj.set('styleNumber', styleNumber);
    return productObj;
  });
    
  return promise;
}

var createProductVariantObject = function(product, variantId, variantOptions, currentVariant) {
  var variantObj = (currentVariant) ? currentVariant : new ProductVariant();
  
  variantObj.set('productId', product.get('productId'));
  variantObj.set('productName', product.get('name'));
  if (product.has('designerProductName')) variantObj.set('designerProductName', product.get('designerProductName'));
  var adjustedPrice = product.get('price');
  
  if (!currentVariant) {
    variantObj.set('variantId', variantId);
  }
  
  var optionValueIds = [];
	if (variantOptions) {
		variantOptions.map(function(variantOption, i) {
  		optionValueIds.push(variantOption.option_value_id);
  		if (variantOption.option_id === 32 || variantOption.option_id === 18) {
    		variantObj.set('size_label', variantOption.label);
    		variantObj.set('size_value', variantOption.value);
  		}
  		if (variantOption.option_id === 3 || variantOption.option_id === 31 || variantOption.option_id === 36 || variantOption.option_id === 30) {
    		variantObj.set('color_label', variantOption.label);
    		variantObj.set('color_value', variantOption.value);
  		}
  		if (variantOption.option_id === 33) {
    		variantObj.set('gemstone_label', variantOption.label);
    		variantObj.set('gemstone_value', variantOption.value);
  		}
  		if (variantOption.option_id === 27) {
    		variantObj.set('font_label', variantOption.label);
    		variantObj.set('font_value', variantOption.value);
  		}
  		if (variantOption.option_id === 26) {
    		variantObj.set('letter_label', variantOption.label);
    		variantObj.set('letter_value', variantOption.value);
  		}
  		if (variantOption.option_id === 35) {
    		variantObj.set('length_label', variantOption.label);
    		variantObj.set('length_value', variantOption.value);
  		}
  		if (variantOption.option_id === 34) {
    		variantObj.set('singlepair_label', variantOption.label);
    		variantObj.set('singlepair_value', variantOption.value);
  		}
  		if (variantOption.adjuster && variantOption.adjuster === 'absolute') adjustedPrice = variantOption.adjuster_value;
  		if (variantOption.adjuster && variantOption.adjuster === 'relative') adjustedPrice += variantOption.adjuster_value;	
  		
  		return variantOption;
		});
		
		variantObj.set('variantOptions', variantOptions);
	}
	variantObj.set('optionValueIds', optionValueIds);
	variantObj.set('adjustedPrice', adjustedPrice);
	
	// Duplicate some properties from parent product
	if (product.has('designer')) variantObj.set('designer', product.get('designer'));
  if (product.has('styleNumber')) variantObj.set('styleNumber', product.get('styleNumber'));
  
  return variantObj;  
}

var getProductSort = function(productsQuery, currentSort) {
  switch (currentSort) {
    case 'date-added-desc':
      productsQuery.descending("date_created");
      break;
    case 'date-added-asc':
      productsQuery.ascending("date_created");
      break;
    case 'price-desc':
      productsQuery.descending("price");
      break;
    case 'price-asc':
      productsQuery.ascending("price");
      break;
    case 'stock-desc':
      productsQuery.descending("total_stock");
      break;
    case 'stock-asc':
      productsQuery.ascending("total_stock");
      break;
    default:
      productsQuery.descending("date_created");
      break;
  }
  return productsQuery;
}

var createCategoryObject = function(categoryData, currentCategory) {
  var categoryObj = (currentCategory) ? currentCategory : new Category();
  
  categoryObj.set('categoryId', parseInt(categoryData.id));
  categoryObj.set('parent_id', parseInt(categoryData.parent_id));
  categoryObj.set('name', categoryData.name);
  categoryObj.set('parent_category_list', categoryData.parent_category_list);
  return categoryObj;
}

var createMetric = function(objectClass, slug, name, value) {
  var metric = new Metric();
  metric.set('objectClass', objectClass);
  metric.set('slug', slug);
  metric.set('name', name);
  metric.set('count', value);
  return metric;
}

var queryResultsToJSON = function(results) {
  console.log(JSON.stringify(results))
  var jsonArray = [];
  _.each(results, function(result) {
    jsonArray.push(result.toJSON());
  });
  return jsonArray;
}

var logInfo = function(i, alwaysLog) {
  if (!isProduction || isDebug || alwaysLog) console.info(i);
}

var logError = function(e) {
  console.error(e);
	if (isProduction) bugsnag.notify(e);
}