const shippo = require('shippo')(process.env.SHIPPO_API_TOKEN);
var moment = require('moment');

const { ShipmentsController } = require('../shipments/shipments.controller');
const { ReturnsModel } = require('./returns.model');

exports.ReturnsController = new class ReturnsController {
  constructor() {
    this.Return = new Parse.Object.extend('Return');
  }

  createOrderProductReturn({ 
    order,
    orderProduct,
    customer,
    product,
    productVariant,
    orderShipment,
    returnTypeId,
  }) {
    if ((typeof order === 'undefined' || order === null) 
        || (typeof orderProduct === 'undefined' || orderProduct === null)
        || (typeof customer === 'undefined' || customer === null)
        || (typeof product === 'undefined' || product === null)
        || (typeof productVariant === 'undefined' || productVariant === null)
        || (typeof orderShipment === 'undefined' || orderShipment === null)
        || (typeof returnTypeId === 'undefined' || returnTypeId === null)) {
      return Promise.reject().then(() => 'missing parameters');
    }

    const createNewReturn = ({ object_id, label_url, rate, parcel  }) => {
      const newReturn = new this.Return();
      return newReturn
        .set('checkedInAt', null)
        .set('orderId', order.get('orderId'))
        .set('order', order)
        .set('orderProductId', orderProduct.get('orderProductId'))
        .set('orderProduct', orderProduct)
        .set('customerId', customer.get('customerId'))
        .set('customer', customer)
        .set('productId', product.get('productId'))
        .set('product', product)
        .set('productVariantId', productVariant.get('variantId'))
        .set('productVariant', productVariant)
        .set('returnStatusId', 0)
        .set('returnStatus', this.returnStatuses(0))
        .set('returnTypeId', returnTypeId)
        .set('returnType', this.returnTypes(returnTypeId))
        .set('returnOptions', null)
        .set('orderShipmentId', orderShipment.get('shipmentId'))
        .set('orderShipment', orderShipment)
        .set('shippoReturnData', { object_id, label_url, rate, parcel })
        .save();
    }

    const addReturnToOrderProduct = (returnObject, orderProduct) => {
      const returns = orderProduct.get('returns') ? orderProduct.get('returns') : [];
      return orderProduct.set('returns', [
        ...returns,
        returnObject
      ]).save()
        .then(updatedOrderProduct => ({
          returnObject,
          orderProduct: updatedOrderProduct
        }));
    }
    
    return this.createReturnLabel(order, orderShipment)
      .then(createNewReturn)
      .then(returnObject => addReturnToOrderProduct(returnObject, orderProduct));

  }

  createReturnLabel(order, orderShipment) {
    const address_from = ShipmentsController.baseAddress;
    const address_to = ShipmentsController.shippoShipmentAddressFromOrder(order);
    const defaultParcel = ShipmentsController.defaultUPSSmallBox;

    return shippo.transaction.create({
      shipment: {
        "object_purpose": "PURCHASE",
        "address_from": { ...address_from, object_purpose: "PURCHASE" },
        "address_to": { ...address_to, object_purpose: "PURCHASE" },
        "parcel": defaultParcel,
        "extra": { "is_return": true },
        "return_of": orderShipment.get('shippo_object_id'),
      },
      "carrier_account": "c67f85102205443e813814c72f2d48c6",
      "servicelevel_token": "usps_priority",
      "async": false,
    });
  }

  returnTypes(index) {
    const returnTypes = ['return', 'resize', 'repair'];
    return typeof index !== 'undefined' ? returnTypes[index] : returnTypes;
  }

  returnStatuses(index) {
    const returnStatuses = ['requested', 'being repaired', 'being resized', 'resize completed', 'repair completed'];
    return typeof index !== 'undefined' ? returnStatuses[index] : returnStatuses;
  }  

}