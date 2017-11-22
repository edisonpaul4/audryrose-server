const { DesignersModel } = require('./designers.model');
const { ProductsModel } = require('../products/products.model');
const { OrdersModel } = require('../orders/orders.model');

exports.DesignersController = new class DesignersController {
  constructor(){}

  getAllPendingVendorOrders(page = 0, sort = "date_added" , direction = "ASC", ordersToSkip = []) {
    const filtersForVendorOrders = ["date_added", "designer"];
    const filtersForProducts = ["product", "retail_price"];

    const startByFilter = sort => {
      return new Promise((resolve, reject) => {
        const filters = {
          limit: 1000,
          skip: page * 100
        };

        if (filtersForVendorOrders.indexOf(sort) !== -1)
          resolve(DesignersModel.getVendorOrdersByFilters({
            ...filters,
            includes: ['vendor', 'vendorOrderVariants', 'vendorOrderVariants.variant'],
            equal: [{ key: 'orderedAll', value: false }, { key: 'receivedAll', value: false }]
          }));
        else if (filtersForProducts.indexOf(sort) !== -1)
          resolve(ProductsModel.getProductsByFilters({
            ...filters,
            equal: [{ key: 'hasVendorOrder', value: true }]
          }));
        else
          reject({ success: false, messages: "Sort is not supported." });
      });
    }

    const setQueryDirection = (query, sort, direction) => {
      if(direction !== 'ASC' && direction !== 'DESC')
        return Promise.reject().then(e => ({ success: false, messages: "Direction is not supported." }));

      switch (sort) {
        case "date_added":
          return direction === 'ASC' ? query.ascending('createdAt') : query.descending('createdAt');

        case "designer":
          return direction === 'ASC' ? query.ascending('vendorOrderNumber') : query.descending('vendorOrderNumber');
          
        case "product":
          return direction === 'ASC' ? query.ascending('name') : query.descending('name');
          
        case "retail_price":
          return direction === 'ASC' ? query.ascending('price') : query.descending('price');
      
        default:
          return query;
      }
    };

    const prepareObjects = query => {
      switch(query.className) {
        case 'VendorOrder':
          return query.find()
            .then(objects => Promise.all(objects.slice(0, 100).map(objectFromVendorOrder)));

        case 'Product':
          return query.find()
            .then(objects => objects.map(objectFromProduct));
      }

      query.first().then(object => {
        console.log(JSON.stringify(object.toJSON()))
      })

      return Promise.resolve('done')
    }

    const objectFromVendorOrder = object => {
      const vendorOrderVariant = object.get('vendorOrderVariants')[0];
      const productVariant = vendorOrderVariant.get('variant');
      
      const getOrderProductByProductId = productId => OrdersModel.getOrderProductsByFilters({
        includes: ['product_options'],
        equal: [{ key: 'product_id', value: productId }]
      }).first();

      return getOrderProductByProductId(productVariant.get('productId'))
        .then(productObject => ({
          dateAdded: object.get('createdAt'),
          designerName: object.get('vendor').get('name'),
          productName: productVariant.get('productName'),
          retailPrice: productVariant.get('adjustedPrice'),
          productOptions: productObject.get('product_options').map(productOption => ({
            displayName: productOption.display_name,
            displayValue: productOption.display_value,
          })),
          totalInventory: productVariant.get('inventoryLevel'),
          totalAwaiting: productVariant.get('totalAwaitingInventory'),
          unitsToOrder: vendorOrderVariant.get('units'),
          note: vendorOrderVariant.get('notes'),
          internalNote: vendorOrderVariant.get('internalNotes'),
        }));
    };

    const objectFromProduct = object => {
      return {
        dateAdded: PropTypes.number.isRequired,
        designerName: PropTypes.string.isRequired,
        productName: PropTypes.string.isRequired,
        retailPrice: PropTypes.number.isRequired,
        productOptions: PropTypes.arrayOf(PropTypes.shape({
          displayName: PropTypes.string.isRequired,
          displayValue: PropTypes.string.isRequired,
        })),
        totalInventory: PropTypes.number.isRequired,
        totalAwaiting: PropTypes.number.isRequired,
        unitsToOrder: PropTypes.number.isRequired,
        note: PropTypes.string.isRequired,
        internalNote: PropTypes.string.isRequired,
      };
    };

    return startByFilter(sort)
      .then(query => setQueryDirection(query, sort, direction))
      .then(prepareObjects)
      .then(vendorOrders => ({
        success: true,
        count: vendorOrders.length,
        vendorOrders
      }));

  }

  /**
   * @returns {Promise} <{ success: boolean }>
   */
  fixClearedVendorOrdersResults() {
    console.log('DesignersController::fixClearedVendorOrdersResults');
    const clearedOrders = DesignersModel.getForcedClearedOrders()
      .then(vendorOrders => vendorOrders.filter(vendorOrder => !vendorOrder.has('dateReceived')));

    const updateVendorOrder = vendorOrders => vendorOrders.map(vendorOrder => {
      const updatedAtAsDateReceived = vendorOrder.get('updatedAt');
      return vendorOrder.set('dateReceived', updatedAtAsDateReceived).save()
        .then(vendorOrder => Promise.all(updateVendorOrderVariants(vendorOrder.get('vendorOrderVariants'))));
    });

    const updateVendorOrderVariants = vendorOrderVariants => vendorOrderVariants.map(vov => vov.set('done', true).save());

    return Promise.resolve(clearedOrders)
      .then(vendorOrders => Promise.all(updateVendorOrder(vendorOrders)))
      .then(() => ({ success: true }));
  }

  completeVendorOrder(vendorOrderNumber) {
    console.log('DesignersController::completeVendorOrder => starting for vendor order number:', vendorOrderNumber);

    var getUpdatedDesignersFromVendorOrder = vendorOrder => {
      console.log('DesignersController::completeVendorOrder::getUpdatedDesignersFromVendorOrder');
      var designer = vendorOrder.get('vendor').get('designers')[0];
      return DesignersModel.getDesignerByObjectId(designer.id)
        .then(updatedDesigner => ({
          updatedDesigner: updatedDesigner.toJSON(),
          vendorOrder: vendorOrder.toJSON()
        }));
    }

    return DesignersModel.finishVendorOrder(vendorOrderNumber)
      .then(getUpdatedDesignersFromVendorOrder);
  }

  removeVendorOrderProduct(productObjectId, vendorOrderNumber){
    console.log('DesignersController::removeVendorOrderProduct => starting for vendor order number:', vendorOrderNumber);
    return DesignersModel.deleteProductFromVendorOrder(productObjectId, vendorOrderNumber)
      .then(results => ({
        vendorOrder: results.vendorOrder.toJSON(),
        vendorOrderVariant: results.vendorOrderVariant.toJSON(),
      }))
  }

}